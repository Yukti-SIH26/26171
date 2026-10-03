/**
 * Action validator — the gate between what the server asks for and what happens.
 *
 * Every action from the remote planner passes through here before the executor
 * sees it. The premise is that the model is useful but not trusted: it may
 * hallucinate a target, it may have been steered by injected text on the page, and
 * it may ask for a secret to be typed somewhere it should not go. None of those
 * are exotic failures — prompt injection via page content is the expected attack
 * on a browser agent, because the attacker controls the page.
 *
 * So the local side holds the authority. Specifically:
 *
 *  - Targets are resolved against the *current* element graph, not the one the
 *    model saw. A stale target is refused rather than guessed at.
 *  - Secrets may only be typed into fields whose own semantics match the secret's
 *    type. A password aimed at a search box is refused even if the model insists.
 *  - A stored credential only works on the site it belongs to. That is what breaks
 *    a look-alike phishing page, and it is enforced here rather than asked about,
 *    because a user confronted with a dialog about a domain name will click yes.
 *  - A rate limit bounds the damage if any of the above is somehow bypassed.
 *
 * There is deliberately no step budget. It capped legitimate long tasks while doing
 * nothing about a model looping on the same action, which is the failure that
 * actually happens; the loop detects repetition directly instead.
 *
 * The validator never resolves a placeholder to its value. It reports whether
 * resolution *would* succeed; the executor does the lookup at dispatch time, so
 * the plaintext exists for as short a window as possible.
 */

import {
  ALL_PII_TYPES,
  allow,
  findNode,
  refuse,
  siteVerdict,
  type AgentAction,
  type ElementGraph,
  type ElementNode,
  type PiiType,
  type ValidationVerdict,
} from '@sih/core';
import { classifyElement } from '../pii/structural.ts';
import type { EntryView } from '../vault/store.ts';

export interface ValidatorContext {
  readonly graph: ElementGraph;
  /** Origin of the page the action will run against. */
  readonly origin: string;
  /** Vault entries, metadata only — no values reach the validator. */
  readonly vault: readonly EntryView[];
  /** Values the user supplied during this browser session, keyed by placeholder id. */
  readonly suppliedPlaceholders: readonly string[];
  /** Local-only type metadata used to apply the same bait-field checks as vault values. */
  readonly suppliedTypes?: Readonly<Record<string, PiiType>>;
  /** Timestamps of recent actions, for the rate limit. */
  readonly recentActionTimes: readonly number[];
}

/** Maximum actions in the rate-limit window. */
/**
 * Ceiling on dispatched actions in the window.
 *
 * Raised from 12 when the model gained the ability to propose a sequence. Filling an
 * eight-field form section is now one legitimate turn that dispatches eight actions, and
 * two such turns inside ten seconds would have tripped the old limit — turning the
 * feature that made forms fast into a self-inflicted refusal.
 *
 * This was never the real defence against a runaway loop anyway. A loop is bounded by
 * the round trip to the model, and what actually catches one is the repeat detector in
 * the agent loop, which notices the *same* proposal arriving again. This is the blunt
 * backstop for something pathological, so it is set well clear of legitimate work.
 */
const RATE_LIMIT_ACTIONS = 60;
const RATE_LIMIT_WINDOW_MS = 10_000;

/**
 * Which element roles may receive a secret of a given type.
 *
 * This is the bait-field defence. A page can label a box anything it likes, but if
 * it declares `autocomplete="cc-number"` while asking for a password, the two
 * disagree and the secret does not go in. Empty set means "any text entry",
 * used for types with no meaningful field-level semantics.
 */
/**
 * Input types that cannot hold a text secret at all.
 *
 * This replaced a per-type allow-list of permitted `input[type]` values, which was the
 * wrong shape and failed in the most damaging direction. `aadhaar` permitted
 * `['aadhaar','text','number']` and `pan` permitted `['pan','text']` — neither listed
 * `tel`, which is the ordinary choice for a twelve-digit Aadhaar box. So the two values
 * that are most tedious to type by hand were the two the agent refused to fill, while
 * `phone` filled cleanly because it had no rule at all and fell through to "any
 * editable field". Absent rules behaved better than present ones, which is a sign the
 * rule was inverted.
 *
 * A deny-list is also the honest expression of the actual policy, which is stated in
 * `fieldAcceptsSecret` below: refuse when the field *declares itself to be something
 * else*, not when it fails to declare itself to be what we want. Most real fields
 * declare nothing.
 */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'checkbox',
  'radio',
  'file',
  'range',
  'color',
  'button',
  'submit',
  'reset',
  'image',
  'hidden',
]);

/**
 * Types whose value must come from the user, never from the model.
 *
 * Anything that identifies a person or authorises something. A search box, a subject
 * line, a quantity, a date of travel — those are the model's to compose. A name, an
 * Aadhaar number or a password is not, and a plausible-looking fake is the worst
 * possible output: it submits cleanly and it is wrong.
 */
const NEVER_INVENTED: ReadonlySet<PiiType> = new Set<PiiType>([
  'person_name',
  // Both halves, not just the whole. Splitting names into `given_name` and `family_name`
  // gave the agent two handles for two boxes, and quietly took those boxes out of this
  // set — so a field carrying `autocomplete="given-name"` went back to accepting an
  // invented "John", which is precisely what this set exists to stop.
  'given_name',
  'family_name',
  'address',
  'email',
  'phone',
  'date_of_birth',
  'aadhaar',
  'pan',
  'passport',
  'voter_id',
  'driving_licence',
  'gstin',
  'credit_card',
  'bank_account',
  'ifsc',
  'upi_id',
  'roll_number',
  'registration_number',
  'vehicle_number',
  'password',
  'otp',
  'cvv',
  'api_key',
  'secret_token',
]);

/**
 * Is the target field an acceptable destination for this secret?
 *
 * Compares the secret's type against what the *markup itself* declares, via the
 * structural detector. Uses the field's own declarations rather than the visible
 * label, because the label is the part an attacker controls most cheaply.
 */
function fieldAcceptsSecret(node: ElementNode, piiType: PiiType): boolean {
  const signals = classifyElement(node);

  // Secrets that are worthless to a page but catastrophic if pasted into the wrong one.
  // For these, and only these, absence of evidence is a refusal: the field has to say
  // it wants a key or a token.
  //
  // `registration_number` and `roll_number` used to be in this list and it broke every
  // login. They are `confirmBeforeUse: false` identifiers a student types into any
  // number of differently-labelled boxes — "Application Number", "Login ID", "User ID" —
  // and a great many real fields carry no machine-readable declaration at all. Demanding
  // one refused the action on every attempt, which is exactly the "that did not work,
  // trying another way" loop. They fall through to the ordinary checks below, which still
  // refuse a field that declares itself to be something else.
  if (
    ['api_key', 'secret_token'].includes(piiType) &&
    !signals.some((finding) => finding.piiType === piiType)
  ) {
    return false;
  }

  // A password must land in a real password field. This is the one case where we
  // refuse on absence of evidence rather than presence of contradiction, because
  // a password typed into a visible text input is also a shoulder-surfing leak.
  if (piiType === 'password') {
    return node.inputType === 'password';
  }

  if (!node.flags.editable) return false;

  // A checkbox or a file picker cannot receive typed text whatever it claims to be.
  if (NON_TEXT_INPUT_TYPES.has(node.inputType ?? 'text')) return false;

  // What does the field say it is, in its own markup? Label-derived evidence is
  // excluded deliberately: the visible label is the part an attacker controls most
  // cheaply, so it must not be what authorises a secret.
  const declared = signals
    .filter((f) => !f.evidence.startsWith('label:'))
    .map((f) => f.piiType);

  // Declared nothing, which is the common case for real-world fields. Allow: there is
  // no contradiction to act on, and refusing here is what emptied the Aadhaar and PAN
  // boxes on a form that was perfectly willing to accept them.
  if (declared.length === 0) return true;

  // It declared something. It must agree, or this is a bait field — a box labelled
  // "Search" that carries `autocomplete="cc-number"`.
  if (declared.includes(piiType)) return true;

  // One exception to the disagreement rule. The government-identifier types are
  // routinely interchangeable in a page's own markup: a portal will mark its single
  // login box `autocomplete="username"` and accept a roll number, a registration
  // number, or an email in it. Treating that as a bait field refuses every real login.
  return (
    INTERCHANGEABLE_IDENTIFIERS.has(piiType) &&
    declared.every((d) => INTERCHANGEABLE_IDENTIFIERS.has(d))
  );
}

/**
 * Identifiers a portal will happily accept in the same box.
 *
 * Grouped because their markup genuinely does not distinguish them, not because the
 * values are equivalent. A page asking for "Login ID" may want any of these, so a
 * declared mismatch between two of them is not evidence of a trap. Nothing outside this
 * set joins the group — a password still has to land in a password field.
 */
const INTERCHANGEABLE_IDENTIFIERS: ReadonlySet<PiiType> = new Set<PiiType>([
  'roll_number',
  'registration_number',
  'person_name',
  'given_name',
  'family_name',
  'email',
  'phone',
]);

function nodeIsActionable(node: ElementNode): ValidationVerdict {
  if (node.flags.hidden) {
    return refuse('not_interactable', `${node.id} is not rendered`);
  }
  if (node.flags.disabled) {
    return refuse('not_interactable', `${node.id} is disabled`);
  }
  if (node.rect.width <= 0 || node.rect.height <= 0) {
    return refuse('not_interactable', `${node.id} has no visible box`);
  }
  if (node.flags.obscured) {
    return refuse('obscured', `something covers ${node.id} — refusing to click through it`);
  }
  return allow();
}

/**
 * Element ids as the two channels produce them: `el_*` from the DOM walk, `px_*`
 * from a pixel-only detection that fusion could not match to any DOM node.
 *
 * Checked with a pattern rather than the `isElementId` guard, because that guard
 * narrows `ElementId` (an alias for `string`) and so negating it yields `never`.
 */
const ELEMENT_ID_PATTERN = /^(?:el|px)_\d+$/;

function resolveTarget(
  graph: ElementGraph,
  target: string,
): { node: ElementNode } | { verdict: ValidationVerdict } {
  if (!ELEMENT_ID_PATTERN.test(target)) {
    return { verdict: refuse('schema', `"${target}" is not an element id`) };
  }
  const node = findNode(graph, target);
  if (node === undefined) {
    // The model was looking at an older version of the page. Guessing at a
    // replacement is how an agent clicks the wrong thing.
    return {
      verdict: refuse(
        'unknown_target',
        `${target} is not on the page any more — the page changed since it was read`,
      ),
    };
  }
  return { node };
}

/**
 * Would this placeholder resolve to a value?
 *
 * Checks availability only. The value itself is fetched by the executor, so it
 * exists in memory for the shortest possible time.
 */
function placeholderResolvable(
  placeholderId: string,
  context: ValidatorContext,
): { ok: true; piiType?: PiiType } | { ok: false; detail: string } {
  const upper = placeholderId.toUpperCase();
  const inferred = [...ALL_PII_TYPES]
    .sort((a, b) => b.length - a.length)
    .find((type) => upper.startsWith(type.toUpperCase()));
  const supplied = context.suppliedPlaceholders.some((id) => id.toUpperCase() === upper);
  if (supplied) {
    const suppliedType = context.suppliedTypes?.[upper];
    const resolvedType = suppliedType ?? inferred;
    return { ok: true, ...(resolvedType === undefined ? {} : { piiType: resolvedType }) };
  }
  if (inferred !== undefined && Object.values(context.suppliedTypes ?? {}).includes(inferred)) {
    return { ok: true, piiType: inferred };
  }

  const entry = context.vault.find(
    (view) => `${view.piiType.toUpperCase()}_${view.slot.toUpperCase()}` === upper,
  );
  if (entry !== undefined) return { ok: true, piiType: entry.piiType };

  // Match the complete type prefix rather than splitting at the first underscore;
  // `REGISTRATION_NUMBER_*` and `SECRET_TOKEN_*` contain underscores themselves.
  const typeGuess = inferred;
  const byType =
    typeGuess === undefined ? [] : context.vault.filter((v) => v.piiType === typeGuess);
  if (byType.length === 1 && byType[0] !== undefined) {
    return { ok: true, piiType: byType[0].piiType };
  }

  return {
    ok: false,
    detail:
      byType.length > 1
        ? `more than one local ${typeGuess?.replace(/_/g, ' ') ?? 'value'} matches`
        : 'that value is missing locally',
  };
}

function checkRateLimit(context: ValidatorContext): ValidationVerdict {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  const recent = context.recentActionTimes.filter((t) => t >= cutoff);
  if (recent.length >= RATE_LIMIT_ACTIONS) {
    return refuse(
      'rate_limited',
      `${String(recent.length)} actions in the last ${String(
        RATE_LIMIT_WINDOW_MS / 1000,
      )}s — pausing in case the loop is runaway`,
    );
  }
  return allow();
}

/**
 * Validate one action against the live page.
 *
 * Ordered cheapest-first, and the rate limit comes before anything that touches
 * page state so a runaway loop is stopped before it can act.
 */
export function validateAction(
  action: AgentAction,
  context: ValidatorContext,
): ValidationVerdict {
  const rate = checkRateLimit(context);
  if (!rate.ok) return rate;

  switch (action.type) {
    // ---- No page interaction ----------------------------------------
    case 'noop':
    case 'stop':
    case 'request_user_input':
      return allow();

    case 'go_back':
    case 'go_forward':
      return allow();

    case 'goto_url': {
      // Where to go is the model's decision. It is the one part of the job that
      // needs judgement about the world — which site a portal lives on, which
      // search to run — and an origin allow-list here only meant the user had to
      // pre-declare every site before the agent could be useful.
      //
      // What made that safe to drop is that the model has nothing worth
      // exfiltrating: everything it ever saw was redacted first, and a credential
      // is refused on any site but its own. So the remaining risk is the scheme,
      // not the host.
      let parsed: URL;
      try {
        parsed = new URL(action.url);
      } catch {
        return refuse('schema', `"${action.url}" is not a valid address`);
      }
      // `javascript:` is code execution in the page and `file:` reads the disk.
      // Neither is navigation in any useful sense.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return refuse(
          'url_not_allowed',
          `${parsed.protocol} addresses are not navigation — only http and https`,
        );
      }
      return allow();
    }

    case 'key_press':
      if (action.keys.trim() === '') return refuse('schema', 'no keys given');
      return allow();

    // ---- Element-targeted -------------------------------------------
    case 'click':
    case 'hover': {
      const resolved = resolveTarget(context.graph, action.target);
      if ('verdict' in resolved) return resolved.verdict;
      if (action.type === 'hover') return allow();
      return nodeIsActionable(resolved.node);
    }

    case 'click_point': {
      const { point } = action;
      const { viewport } = context.graph;
      if (
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x < 0 ||
        point.y < 0 ||
        point.x > viewport.width ||
        point.y > viewport.height
      ) {
        return refuse(
          'schema',
          `(${String(point.x)}, ${String(point.y)}) is outside the viewport`,
        );
      }
      return allow();
    }

    case 'scroll': {
      if (action.target === undefined) return allow();
      const resolved = resolveTarget(context.graph, action.target);
      return 'verdict' in resolved ? resolved.verdict : allow();
    }

    case 'select': {
      const resolved = resolveTarget(context.graph, action.target);
      if ('verdict' in resolved) return resolved.verdict;
      const actionable = nodeIsActionable(resolved.node);
      if (!actionable.ok) return actionable;

      if (action.option.kind === 'placeholder') {
        const check = placeholderResolvable(action.option.placeholderId, context);
        if (!check.ok) return refuse('unresolvable_placeholder', check.detail);
      }
      return allow();
    }

    // ---- The one that matters ---------------------------------------
    case 'type': {
      const resolved = resolveTarget(context.graph, action.target);
      if ('verdict' in resolved) return resolved.verdict;
      const node = resolved.node;

      const actionable = nodeIsActionable(node);
      if (!actionable.ok) return actionable;

      if (!node.flags.editable) {
        return refuse('not_interactable', `${node.id} does not accept text`);
      }

      // A literal used to be waved through on the grounds that the model composed it, so
      // it could not be the user's data. That reasoning is backwards for an identity
      // field: asked to fill a form the model cheerfully typed "John", "Doe" and a
      // made-up twelve-digit Aadhaar number into a real government form. Invented
      // personal data is worse than no data — it is wrong, it looks deliberate, and on a
      // real portal it gets submitted.
      //
      // So a field that declares itself as personal or secret takes a stored value or a
      // value the user just gave, never a literal the model wrote.
      if (action.value.kind === 'literal') {
        const declares = classifyElement(node)
          .filter((signal) => signal.confidence >= 0.6)
          .map((signal) => signal.piiType)
          .find((type) => NEVER_INVENTED.has(type));

        if (declares !== undefined && action.value.text.trim() !== '') {
          return refuse(
            'secret_target_mismatch',
            `${node.id} is a ${declares.replace(/_/g, ' ')} field, so it needs the user's real ` +
              `value: use a saved handle, or ask with request_user_input. Never type one you made up.`,
          );
        }
        return allow();
      }

      // Captured to a local because the narrowing above is lost inside the
      // closure passed to `.find()` further down.
      const placeholderId = action.value.placeholderId;

      const check = placeholderResolvable(placeholderId, context);
      if (!check.ok) return refuse('unresolvable_placeholder', check.detail);

      const piiType = check.piiType;
      if (piiType === undefined) return allow();

      // Bait-field check.
      if (!fieldAcceptsSecret(node, piiType)) {
        return refuse(
          'secret_target_mismatch',
          `refusing to type a ${piiType.replace(/_/g, ' ')} into ${node.id} — the field ` +
            `is a ${node.inputType ?? node.role}, which does not match`,
        );
      }

      // Site binding. A credential saved on one site does not travel to another,
      // which is the whole anti-phishing story and needs no dialog.
      const wanted = placeholderId.toUpperCase();
      const entry = context.vault.find(
        (view) => `${view.piiType.toUpperCase()}_${view.slot.toUpperCase()}` === wanted,
      );
      if (entry !== undefined) {
        const verdict = siteVerdict(
          {
            slot: entry.slot,
            piiType: entry.piiType,
            label: entry.label,
            value: '',
            createdAt: 0,
            updatedAt: entry.updatedAt,
            ...(entry.site === undefined ? {} : { site: entry.site }),
            usedOn: entry.usedOn,
          },
          context.origin,
        );
        if (verdict === 'refuse') {
          return refuse(
            'wrong_site',
            `"${entry.label}" belongs to ${entry.site ?? 'another site'} and this page is ` +
              `${context.origin}, so it will not be used here`,
          );
        }
      }

      return allow();
    }

    default: {
      // Exhaustiveness: a new action type must be considered here explicitly
      // rather than silently allowed.
      const exhaustive: never = action;
      return refuse('schema', `unhandled action ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Validate a batch, stopping at the first refusal. */
export function validateSequence(
  actions: readonly AgentAction[],
  context: ValidatorContext,
): { readonly index: number; readonly verdict: ValidationVerdict } {
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (action === undefined) continue;
    const verdict = validateAction(action, context);
    if (!verdict.ok) return { index: i, verdict };
  }
  return { index: actions.length, verdict: allow() };
}

export {
  INTERCHANGEABLE_IDENTIFIERS,
  NON_TEXT_INPUT_TYPES,
  RATE_LIMIT_ACTIONS,
  RATE_LIMIT_WINDOW_MS,
};
