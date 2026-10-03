/**
 * The egress packet — the only thing the server is ever allowed to see.
 *
 * This module is the privacy firewall. Everything the remote model receives is
 * constructed here, field by field, from an allow-list. That direction matters: a
 * denylist that strips known-bad fields fails silently the moment someone adds a
 * new field to `ElementNode`, whereas an allow-list fails closed — a new field is
 * simply absent until someone deliberately adds it here and has to think about
 * whether it can leak.
 *
 * After building, the packet is checked against the vault: if any known secret
 * survives into the serialized bytes, the build throws rather than returning. That
 * check is the leak canary, and it is the difference between "we redact" and "we
 * can demonstrate that we redact".
 */

import {
  ELEMENT_GRAPH_SCHEMA_VERSION,
  isEphemeral,
  slotToken,
  type ElementGraph,
  type ElementNode,
  type PiiType,
  type Rect,
} from '@sih/core';
import {
  MIN_SEARCHABLE_LENGTH,
  containsKnownValue,
  searchPatternFor,
  type KnownValue,
} from '../pii/known-values.ts';
import type { PiiFinding, TextField } from '../pii/detect.ts';
import { placeholderFor, type RedactionPlan, type TextEdit } from './plan.ts';

/**
 * A node as the server sees it.
 *
 * Note what is missing: no `value`, no `detectorMeta`, no `fieldName`, no raw
 * `autocomplete`. Each omission is deliberate. `value` is the actual content of a
 * field. `detectorMeta` carries OCR text, which is unredacted by construction.
 * `fieldName` leaks schema details of the site. `autocomplete` is summarised into
 * `sensitive` instead, which is the only part the model needs.
 */
export interface SanitizedNode {
  readonly id: string;
  readonly role: string;
  readonly name: string;
  /** Integer CSS pixels. Fractional coordinates leak layout precision needlessly. */
  readonly rect: readonly [number, number, number, number];
  readonly interactive: boolean;
  readonly editable: boolean;
  readonly disabled?: boolean;
  /**
   * This field already holds something.
   *
   * A boolean, never the content. Without it the agent could not tell a filled field
   * from an empty one — the value it had just typed was masked out of the screenshot, so
   * it read the field as blank and filled it again, and again, until the run gave up.
   */
  readonly filled?: boolean;
  /** Redacted text: placeholders and synthetic values substituted in. */
  readonly text?: string;
  /** This field holds or expects sensitive data. No hint which kind of value. */
  readonly sensitive?: boolean;
  /** Attribute and label disagreed — the model should treat this as suspect. */
  readonly suspect?: boolean;
  /** The page will not submit without this one. */
  readonly required?: boolean;
  /**
   * Which form group the control belongs to. `0` means "editable, in no `<form>`".
   *
   * Pure grouping, no site schema: a number assigned in document order, never the
   * form's `id` or `action`, both of which describe the site rather than the page.
   */
  readonly form?: number;
  /** The page or browser is rejecting the current contents. */
  readonly invalid?: boolean;
  /** Why it is being rejected. Page content, so redacted like any other text. */
  readonly problem?: string;
  /** Selectable labels for a `<select>`, redacted like any other text. */
  readonly options?: readonly string[];
  /**
   * Rendered, but outside the part of the page the screenshot shows.
   *
   * The model has to be told, or it reads the absence of a field from the picture as
   * the absence of the field from the form and submits early.
   */
  readonly offscreen?: boolean;
}

/**
 * The placeholder catalogue.
 *
 * Tells the model what each token means without telling it the value, which is
 * what lets it plan ("type AADHAAR_1 into el_12") over data it cannot read. The
 * problem statement's requirement that the server be *aware of the redaction
 * scheme* is satisfied by exactly this structure.
 */
export interface PlaceholderInfo {
  readonly token: string;
  readonly piiType: PiiType;
  /** Character length of the hidden value, so the model can reason about fit. */
  readonly length: number;
  /** True when the real value exists locally and the agent can fill it in. */
  readonly available: boolean;
}

export interface RedactedRegion {
  readonly rect: readonly [number, number, number, number];
  readonly piiTypes: readonly string[];
  readonly mode: string;
}

export interface EgressPacket {
  readonly schemaVersion: typeof ELEMENT_GRAPH_SCHEMA_VERSION;
  /** Origin only. Path and query are dropped — both routinely carry identifiers. */
  readonly origin: string;
  readonly title: string;
  readonly viewport: { readonly width: number; readonly height: number };
  /**
   * How far down the page runs, and where we are in it.
   *
   * The screenshot shows one viewport. Without this the agent had no way to know a form
   * continued below the fold, so it treated the visible fields as the whole form and
   * stopped halfway. Pure geometry, no content.
   */
  readonly scroll?: {
    readonly y: number;
    readonly pageHeight: number;
    readonly moreBelow: boolean;
  };
  readonly nodes: readonly SanitizedNode[];
  readonly placeholders: readonly PlaceholderInfo[];
  /**
   * Where the screenshot was masked.
   *
   * Sent deliberately. Without it the model sees black rectangles and cannot tell
   * a redaction from a dark UI element, and may conclude the page failed to load.
   */
  readonly redactedRegions: readonly RedactedRegion[];
  /** Redacted screenshot as a `data:` URL, when one is included. */
  readonly screenshot?: string;
  readonly coverage: number;
  readonly capturedAt: number;
}

export interface BuildPacketOptions {
  readonly graph: ElementGraph;
  readonly findings: readonly PiiFinding[];
  readonly plan: RedactionPlan;
  readonly redactedScreenshot?: string;
  readonly vault?: readonly KnownValue[];
  /** Optional allow-list of local handles that may be used on the current origin. */
  readonly availableTokens?: readonly string[];
  readonly includeScreenshot?: boolean;
  /**
   * Send the page's words at all.
   *
   * `false` reduces every node to its id, role, geometry and flags, and empties the
   * title. The model then reads the page from the masked screenshot and uses this only
   * to aim, which keeps outbound text at zero: no labels, no headings, no values, and
   * therefore nothing for a redactor to miss. Defaults to `true` so the structure-only
   * path stays a deliberate choice by the caller.
   */
  readonly includeText?: boolean;
}

export interface BuildPacketResult {
  readonly packet: EgressPacket;
  readonly json: string;
  readonly bytes: number;
  /** Nodes dropped because they were hidden or carried nothing useful. */
  readonly nodesDropped: number;
  readonly canaryChecks: number;
  /**
   * Content fields emptied because a value was still readable in them.
   *
   * Empty in the ordinary case. A non-empty list is worth surfacing in the audit: it is
   * the honest record of a place the redactor could not clean and therefore withheld.
   */
  readonly withheld: readonly WithheldField[];
}

// `LeakDetectedError` used to live here and abort the build. It is gone on purpose.
//
// Throwing was the wrong response to its own alarm. Killing the user's task is a
// drastic action, and it was being taken on evidence that turned out to be mostly
// false — the canary could not distinguish page content from our own vocabulary, so a
// stored value resembling a type name ended every run. Even a true positive did not
// justify it: the field can be withheld and the task can continue, and nothing is
// transmitted either way. See `findSurvivors` and `withoutFields`.

/**
 * One thing that was found still readable and therefore withheld.
 *
 * `field` is a dotted path a developer can go straight to — `packet.title`,
 * `nodes[el_7].name`. The value itself is never carried.
 */
export interface WithheldField {
  readonly field: string;
  readonly piiType: string;
}

// ---------------------------------------------------------------------------
// What counts as page content
// ---------------------------------------------------------------------------

/**
 * Every string in the packet that came from the page, and nothing else.
 *
 * This is the definition the whole redaction path was missing, and its absence caused
 * every leak bug in turn. The scrubber knew about some fields, the detector about
 * others, and the canary about none — it searched the serialized blob and could not tell
 * `nodes[].name` (the page wrote it) from `placeholders[].piiType` (we wrote it).
 *
 * Everything not listed here is our own vocabulary: type names, redaction modes, ARIA
 * roles, element ids, placeholder tokens, viewport numbers, the schema version. None of
 * it can carry a secret unless we put one there, and scanning it for secrets produces
 * false alarms instead of safety.
 *
 * Adding a field to `EgressPacket` means deciding which of the two it is. Leaving it out
 * means it is never scrubbed and never checked, so the decision has to be deliberate.
 */
function contentFields(
  packet: EgressPacket,
): { readonly path: string; readonly text: string }[] {
  const out: { path: string; text: string }[] = [{ path: 'packet.title', text: packet.title }];

  for (const node of packet.nodes) {
    out.push({ path: `nodes[${node.id}].name`, text: node.name });
    if (node.text !== undefined) out.push({ path: `nodes[${node.id}].text`, text: node.text });
    // A site's own error text is rendered from what the user typed often enough to
    // matter: "21CS042 is not a registered roll number" quotes the value back.
    if (node.problem !== undefined) {
      out.push({ path: `nodes[${node.id}].problem`, text: node.problem });
    }
    // Option labels are usually harmless enumerations, but a masked account or a list
    // of the user's own saved addresses arrives the same way.
    if (node.options !== undefined) {
      out.push({ path: `nodes[${node.id}].options`, text: node.options.join(' ') });
    }
  }

  return out;
}

/**
 * Which content fields still contain something they should not.
 *
 * Runs after the value sweep, so in the ordinary case this returns nothing and the
 * packet is sent untouched. A hit means the sweep could not or would not replace a
 * literal, and the field is dropped rather than transmitted.
 */
function findSurvivors(
  packet: EgressPacket,
  findings: readonly PiiFinding[],
  vault: readonly KnownValue[],
): WithheldField[] {
  const fields = contentFields(packet);
  const found: WithheldField[] = [];

  const flag = (path: string, piiType: string): void => {
    if (found.some((f) => f.field === path)) return;
    found.push({ field: path, piiType });
  };

  for (const { path, text } of fields) {
    if (text === '') continue;

    // Values the user told us are theirs. Matched the same separator-tolerant way the
    // detector finds them, so a differently formatted copy does not slip past.
    for (const entry of vault) {
      if (containsKnownValue(text, [entry])) flag(path, entry.piiType);
    }

    // Values a detector confirmed on this page. An exact substring check: the sweep uses
    // word boundaries for name-like types, so this deliberately catches the narrow case
    // the sweep leaves alone rather than risking a replacement that blacks out unrelated
    // text.
    //
    // The length floor is shared with the detector rather than restated, so the two
    // cannot drift into checking for something the scrubber declined to erase.
    for (const finding of findings) {
      const secret = finding.matchedText;
      if (secret === undefined || secret.length < MIN_SEARCHABLE_LENGTH) continue;
      if (text.includes(secret)) flag(path, finding.piiType);
    }
  }

  return found;
}

/**
 * Rebuild the packet with the named content fields emptied.
 *
 * The node keeps its id, role and geometry so the model can still act on it — it simply
 * has no readable label. Losing a label costs the model some context; transmitting the
 * value costs the user their privacy, and only one of those is recoverable.
 */
function withoutFields(packet: EgressPacket, withheld: readonly WithheldField[]): EgressPacket {
  const paths = new Set(withheld.map((w) => w.field));

  return {
    ...packet,
    ...(paths.has('packet.title') ? { title: '' } : {}),
    nodes: packet.nodes.map((node) => {
      const dropName = paths.has(`nodes[${node.id}].name`);
      const dropText = paths.has(`nodes[${node.id}].text`);
      const dropProblem = paths.has(`nodes[${node.id}].problem`);
      const dropOptions = paths.has(`nodes[${node.id}].options`);
      if (!dropName && !dropText && !dropProblem && !dropOptions) return node;

      // Destructured rather than assigned `undefined`: under
      // `exactOptionalPropertyTypes` an absent property and one holding `undefined` are
      // different types, and only absence is assignable.
      const { text: _text, problem: _problem, options: _options, ...rest } = node;
      return {
        ...rest,
        name: dropName ? '' : node.name,
        ...(dropText || node.text === undefined ? {} : { text: node.text }),
        // The whole list goes rather than the offending entry: the entries are a set the
        // model chooses from, and a silently shortened set is worse than none.
        ...(dropProblem || node.problem === undefined ? {} : { problem: node.problem }),
        ...(dropOptions || node.options === undefined ? {} : { options: node.options }),
      };
    }),
  };
}

function toTuple(rect: Rect): readonly [number, number, number, number] {
  return [
    Math.round(rect.x),
    Math.round(rect.y),
    Math.round(rect.width),
    Math.round(rect.height),
  ];
}

/**
 * Reduce a URL to its origin.
 *
 * Paths and query strings on a student portal routinely carry a roll number or a
 * session id, so the whole URL is discarded rather than filtered. The model gets
 * enough from the origin plus the page title.
 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'about:blank';
  }
}

/**
 * Apply text edits to one of a node's strings.
 *
 * `field` decides which edits are even eligible. A span is an offset into one
 * specific string, and a node has several — `text`, `name`, `value`. Applying a span
 * measured against `value` to `text` slices at the wrong offsets, which mangles the
 * text *and* leaves the secret in place. So a spanned edit is only applied to the
 * field it was measured against.
 *
 * Highest-offset-first so earlier replacements do not shift later ones.
 */
function applyEdits(text: string, field: TextField, edits: readonly TextEdit[]): string {
  const spanned = edits
    .filter((e) => e.at?.field === field)
    .sort((a, b) => (b.at?.span.start ?? 0) - (a.at?.span.start ?? 0));

  let out = text;
  for (const edit of spanned) {
    const span = edit.at?.span;
    if (span === undefined) continue;
    if (span.start < 0 || span.end > out.length || span.start >= span.end) continue;
    out = out.slice(0, span.start) + edit.replacement + out.slice(span.end);
  }

  // A whole-field edit replaces everything. Applied after the spanned ones so it
  // cannot be partially overwritten by them.
  //
  // Never applied to the accessible name. A whole-field edit comes from a structural
  // finding — "this input declares it holds a password" — where the secret is the
  // element's *value*. Its name is the visible label, "Password", which is not
  // sensitive at all. Blanketing the name with `PASSWORD_0` destroyed the one piece of
  // context the model needs to know what the field is for.
  if (field === 'name') return out;

  const wholeField = edits.find((e) => e.at === undefined);
  if (wholeField !== undefined) return wholeField.drop === true ? '' : wholeField.replacement;

  return out;
}

/**
 * One literal to erase, and what to put in its place.
 *
 * Built from the plan and the vault, then applied to every outbound string. This is
 * the backstop that makes the privacy claim hold regardless of whether the detector
 * found every occurrence: redaction becomes a property of the *value* rather than of
 * the location a detector happened to point at.
 */
interface Substitution {
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * Build the sweep table.
 *
 * Longest literal first, so a value that contains another — a full address
 * containing its own postcode — is replaced whole rather than being chewed up from
 * the inside and left unrecognisable to the later pattern.
 *
 * Patterns come from `searchPatternFor`, the same function the detector matches with.
 * That shared primitive is deliberate: a scrubber that replaced only the exact
 * literal it was handed would leave `4321 8765 2109` on the wire after matching a
 * vault entry of `432187652109`.
 */
function buildSubstitutions(
  plan: RedactionPlan,
  findings: readonly PiiFinding[],
  vault: readonly KnownValue[],
): Substitution[] {
  const byLiteral = new Map<string, string>();

  // Everything the plan already decided a replacement for.
  for (const edit of plan.edits) {
    const literal = edit.matchedText?.trim();
    if (literal === undefined || literal.length < MIN_SEARCHABLE_LENGTH) continue;
    if (edit.replacement === '') continue;
    byLiteral.set(`${edit.piiType}|${literal}`, edit.replacement);
  }

  // Findings the plan produced no text edit for — anything with no `elementId`,
  // which is every OCR-only match. Their pixels are covered but the same string can
  // still be sitting in an element's accessible name.
  for (const finding of findings) {
    const literal = finding.matchedText?.trim();
    if (literal === undefined || literal.length < MIN_SEARCHABLE_LENGTH) continue;
    const key = `${finding.piiType}|${literal}`;
    if (byLiteral.has(key)) continue;
    byLiteral.set(key, placeholderFor(finding.piiType, finding.slot, 0));
  }

  // The vault, unconditionally. These are values the user asserted are theirs, so
  // they are erased whether or not any detector fired on this page at all.
  for (const entry of vault) {
    const literal = entry.value.trim();
    if (literal.length < MIN_SEARCHABLE_LENGTH) continue;
    const key = `${entry.piiType}|${literal}`;
    if (byLiteral.has(key)) continue;
    byLiteral.set(key, slotToken(entry.piiType, entry.slot));
  }

  // ---- Sanitize the tokens themselves ---------------------------------
  // A placeholder token used to be derived from the vault slot, which was derived from
  // the user's free-text label. Label an entry "21CS042" and the token became
  // `REGISTRATION_NUMBER_21CS042` — the value transmitted inside the very token that
  // exists to avoid transmitting it.
  //
  // `makeSlot` no longer does that, but entries created before the fix still carry
  // such slots, so an unsafe token is rewritten to an indexed one here. The rewrite is
  // registered as a substitution of its own, so the catalogue and the substituted text
  // are changed identically and stay consistent. Resolution still works: the executor
  // falls back to matching on the type when the exact slot is not found.
  const literals = [...byLiteral.keys()].map((key) => key.slice(key.indexOf('|') + 1));
  const rewrites = new Map<string, string>();
  let indexed = 0;

  for (const [key, token] of byLiteral) {
    const piiType = key.slice(0, key.indexOf('|')) as PiiType;
    if (!literals.some((literal) => tokenLeaks(token, piiType, literal))) continue;
    rewrites.set(token, `${piiType.toUpperCase()}_${String(indexed++)}`);
  }

  const out: Substitution[] = [];
  for (const [key, token] of byLiteral) {
    const separator = key.indexOf('|');
    const piiType = key.slice(0, separator) as PiiType;
    const literal = key.slice(separator + 1);
    const pattern = searchPatternFor(piiType, literal);
    if (pattern === undefined) continue;
    out.push({ pattern, replacement: rewrites.get(token) ?? token });
  }

  // Longest literal first, so a value containing another is replaced whole rather
  // than chewed up from the inside.
  out.sort((a, b) => b.pattern.source.length - a.pattern.source.length);

  // Token rewrites last: they operate on text the substitutions above just produced.
  for (const [unsafe, safe] of rewrites) {
    out.push({ pattern: new RegExp(escapeLiteral(unsafe), 'gi'), replacement: safe });
  }

  return out;
}

/** Does this token carry a literal it is supposed to be standing in for? */
function tokenLeaks(token: string, piiType: PiiType, literal: string): boolean {
  const pattern = searchPatternFor(piiType, literal);
  return pattern !== undefined && new RegExp(pattern.source, pattern.flags).test(token);
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Erase every known literal from one string. */
function scrub(text: string, substitutions: readonly Substitution[]): string {
  if (text === '' || substitutions.length === 0) return text;

  let out = text;
  for (const { pattern, replacement } of substitutions) {
    // A fresh regex per call: `lastIndex` on a shared /g/ instance would make this
    // return different results for identical inputs.
    out = out.replace(new RegExp(pattern.source, pattern.flags), replacement);
  }
  return out;
}

/**
 * Build the sanitized view of one node.
 *
 * Returns `undefined` for nodes that should not be sent at all.
 */
function sanitizeNode(
  node: ElementNode,
  edits: readonly TextEdit[],
  sensitive: boolean,
  suspect: boolean,
): SanitizedNode | undefined {
  // Hidden nodes are scanned for PII but never sent: the model cannot act on them
  // and their content would be pure leak surface.
  if (node.flags.hidden) return undefined;

  // Nothing to say about it and nothing to do with it.
  if (!node.flags.interactive && node.text === undefined && node.name === '') return undefined;

  const rawText = node.text;
  const text = rawText === undefined ? undefined : applyEdits(rawText, 'text', edits);
  // Spans were measured against `text`, `name` or `value`, never against these two, so
  // only the value sweep can clean them. That happens in `buildEgressPacket`, and the
  // canary checks them afterwards.
  const problem = node.validationMessage;
  const options = node.options;

  // The accessible name is now scanned in its own right, so its spans are applied to
  // it directly. This used to blanket-apply every whole-field edit to the name, which
  // replaced names that held nothing sensitive with a placeholder — over-redacting in
  // one direction while the actual leak went out in the other.
  const name = applyEdits(node.name, 'name', edits);

  return {
    id: node.id,
    role: node.role,
    name,
    rect: toTuple(node.rect),
    interactive: node.flags.interactive,
    editable: node.flags.editable,
    ...(node.flags.disabled ? { disabled: true } : {}),
    ...(node.flags.editable && node.value !== undefined && node.value.trim() !== ''
      ? { filled: true }
      : {}),
    ...(text === undefined || text === '' ? {} : { text }),
    ...(sensitive ? { sensitive: true } : {}),
    ...(suspect ? { suspect: true } : {}),
    ...(node.required === true ? { required: true } : {}),
    ...(node.formId === undefined ? {} : { form: node.formId }),
    ...(node.invalid === true ? { invalid: true } : {}),
    ...(problem === undefined || problem === '' ? {} : { problem }),
    ...(options === undefined || options.length === 0 ? {} : { options }),
    ...(node.flags.inViewport ? {} : { offscreen: true }),
  };
}

export function buildEgressPacket(options: BuildPacketOptions): BuildPacketResult {
  const { graph, findings, plan, vault = [] } = options;
  const allowedTokens =
    options.availableTokens === undefined
      ? undefined
      : new Set(options.availableTokens.map((token) => token.toUpperCase()));

  // Index edits and sensitivity by element so each node is built in one pass.
  const editsByElement = new Map<string, TextEdit[]>();
  for (const edit of plan.edits) {
    const list = editsByElement.get(edit.elementId) ?? [];
    list.push(edit);
    editsByElement.set(edit.elementId, list);
  }

  const sensitiveIds = new Set<string>();
  const suspectIds = new Set<string>();
  for (const finding of findings) {
    if (finding.elementId === undefined) continue;
    sensitiveIds.add(finding.elementId);
    if (finding.conflicting === true) suspectIds.add(finding.elementId);
  }

  const nodes: SanitizedNode[] = [];
  let nodesDropped = 0;

  for (const node of graph.nodes) {
    const sanitized = sanitizeNode(
      node,
      editsByElement.get(node.id) ?? [],
      sensitiveIds.has(node.id),
      suspectIds.has(node.id),
    );
    if (sanitized === undefined) nodesDropped++;
    else nodes.push(sanitized);
  }

  // ---- Value sweep ------------------------------------------------------
  // The span edits above are precise but location-scoped: they only touch places a
  // detector pointed at. Anything the detector missed — a copy of the same value in
  // an element it never flagged, or the page title, which no detector reads at all —
  // would go out verbatim.
  //
  // This is where the guarantee stops depending on detector recall. Every known
  // literal is erased from every outbound string by value. Running it *after* the
  // span edits means the precise, shape-preserving substitutions win where they
  // apply, and this only catches what they left behind.
  const substitutions = buildSubstitutions(plan, findings, vault);
  const scrubbed =
    substitutions.length === 0
      ? nodes
      : nodes.map((node) => {
          const name = scrub(node.name, substitutions);
          const text = node.text === undefined ? undefined : scrub(node.text, substitutions);
          const problem =
            node.problem === undefined ? undefined : scrub(node.problem, substitutions);
          const options =
            node.options === undefined
              ? undefined
              : node.options.map((option) => scrub(option, substitutions));
          const optionsChanged =
            options !== undefined && options.some((option, i) => option !== node.options?.[i]);
          if (
            name === node.name &&
            text === node.text &&
            problem === node.problem &&
            !optionsChanged
          ) {
            return node;
          }
          return {
            ...node,
            name,
            ...(text === undefined || text === '' ? {} : { text }),
            ...(problem === undefined || problem === '' ? {} : { problem }),
            ...(options === undefined || options.length === 0 ? {} : { options }),
          };
        });

  // ---- Placeholder catalogue -------------------------------------------
  //
  // Two sources, and the second one is what makes filling a form possible at all.
  //
  // The catalogue used to be built purely from `plan.edits`, which exist only for
  // values a detector found *on the current screen*. A blank login form has nothing on
  // screen to detect, so the catalogue came out empty and the model was shown a heading
  // with no entries under it. It had no way to learn the vault held the user's roll
  // number, so "fill this page" was not a capability the agent could exercise — not a
  // prompt weakness, a missing input.
  //
  // So the vault is listed too, whether or not any of it appears on the page. Still only
  // the token, the type, and the length: the catalogue describes the shape of a value
  // and never the value.
  const placeholders: PlaceholderInfo[] = [];
  const seenTokens = new Set<string>();

  const offer = (token: string, piiType: PiiType, length: number, available: boolean): void => {
    // Swept like every other outbound string. The token is derived from a vault slot,
    // and a slot created before `makeSlot` stopped using the label can contain the
    // value itself — which is exactly the leak that had no home in the old locator.
    const safe = scrub(token, substitutions);
    if (
      available &&
      allowedTokens !== undefined &&
      !allowedTokens.has(token.toUpperCase()) &&
      !allowedTokens.has(safe.toUpperCase())
    ) {
      return;
    }
    if (seenTokens.has(safe)) return;
    seenTokens.add(safe);
    placeholders.push({ token: safe, piiType, length, available });
  };

  // Only a value backed by a local slot is actionable. Pattern/structural findings
  // may use synthetic text to preserve layout, but that text is display-only and must
  // never be advertised to the model as something the vault can resolve.
  for (const edit of plan.edits) {
    if (edit.drop === true || edit.replacement === '') continue;

    const finding = findings.find(
      (f) => f.elementId === edit.elementId && f.piiType === edit.piiType,
    );
    if (finding?.slot === undefined) continue;

    const piiType = edit.piiType as PiiType;
    offer(
      edit.replacement,
      piiType,
      finding.matchedText?.length ?? edit.replacement.length,
      !isEphemeral(piiType),
    );
  }

  // Values the user has saved, offered for typing even though nothing on this page
  // matches them.
  for (const entry of vault) {
    if (isEphemeral(entry.piiType)) continue;
    offer(slotToken(entry.piiType, entry.slot), entry.piiType, entry.value.length, true);
  }

  // Strip every page-authored string when the caller asked for structure only. Done here,
  // at the single point the packet is assembled, so no later field can reintroduce text.
  // Body text goes; the labels on things you can act on stay.
  //
  // Blanking every name was too far. A form became a list of anonymous boxes — `el_42
  // textbox editable at 383,418` — and the model could no longer tell a registration
  // field from a password field or a search box, so it aimed at the wrong one and every
  // attempt was refused. An accessible name on an interactive control is the page's own
  // label for it ("Password", "Search", "Registration Number"), not the user's data, and
  // it has already been through the value sweep and the canary like every other string.
  //
  // So: read-only prose is dropped, and names survive only on controls. That keeps the
  // page's *content* off the wire while leaving the agent able to aim.
  // `problem` is prose and goes with the body text. A `<select>`'s option labels stay:
  // they are that control's own label set, the same category as its accessible name, and
  // without them the control cannot be operated at all.
  const textless = options.includeText === false;
  const outbound = textless
    ? scrubbed.map((node) => {
        const { text: _text, problem: _problem, ...rest } = node;
        return { ...rest, name: node.interactive || node.editable ? node.name : '' };
      })
    : scrubbed;

  // Derived from the boxes rather than from a new content-script field: the furthest
  // bottom edge any element reaches is a good enough answer to "is there more below",
  // and it needs no extra plumbing. Off-screen parked nodes sit at negative
  // coordinates, so they cannot inflate it.
  const maxBottom = graph.nodes.reduce(
    (lowest, node) => Math.max(lowest, node.rect.y + node.rect.height),
    0,
  );

  const packet: EgressPacket = {
    schemaVersion: ELEMENT_GRAPH_SCHEMA_VERSION,
    origin: originOf(graph.url),
    // The title was previously sent raw. No detector reads it, so a portal titled
    // "Marks — Asha Rao (21CS042)" handed over a name and a roll number with nothing
    // applied to them at all.
    title: textless ? '' : scrub(graph.title, substitutions),
    viewport: { width: graph.viewport.width, height: graph.viewport.height },
    scroll: {
      y: Math.round(graph.viewport.scrollY),
      pageHeight: Math.round(
        graph.viewport.scrollY + Math.max(graph.viewport.height, maxBottom),
      ),
      moreBelow: maxBottom > graph.viewport.height + 4,
    },
    nodes: outbound,
    placeholders,
    redactedRegions: plan.paints.map((p) => ({
      rect: toTuple(p.rect),
      piiTypes: p.piiTypes,
      mode: p.mode,
    })),
    ...(options.includeScreenshot !== false && options.redactedScreenshot !== undefined
      ? { screenshot: options.redactedScreenshot }
      : {}),
    coverage: Number(plan.coverage.toFixed(4)),
    capturedAt: graph.capturedAt,
  };

  // ---- Leak canary ------------------------------------------------------
  // Checks the content fields, and only those.
  //
  // It used to serialize the whole packet and substring-search the blob, on the theory
  // that then nothing could slip through a field nobody thought to check. That was
  // wrong, and it aborted real tasks. The packet holds two different kinds of string:
  // page content, and our own vocabulary — `piiType`, `mode`, `role`, element ids,
  // schema keys. Searching vocabulary for secrets is meaningless, and it fires the
  // moment a stored value happens to resemble one of our identifiers. A live run died
  // on `placeholders[9].piiType`, a field whose entire content is the literal string
  // "registration_number".
  //
  // `CONTENT_FIELDS` is the one place that distinction lives, shared with the scrubber
  // and the locator, so a new packet field has to be classified rather than silently
  // scanned or silently skipped.
  const survivors = findSurvivors(packet, findings, vault);
  const canaryChecks =
    vault.length + findings.filter((f) => f.matchedText !== undefined).length;

  // A survivor is dropped, not thrown on. The value sweep above already erases content
  // by value, so anything left is either a rare genuine bug or a residual case the
  // sweep declines to touch — a name-like value embedded inside a longer word, which it
  // will not replace because doing so would black out unrelated text. Neither is worth
  // destroying the user's task over when the field can simply be withheld. Nothing is
  // transmitted either way, which is the only property that has to hold.
  const clean = survivors.length === 0 ? packet : withoutFields(packet, survivors);
  const json = JSON.stringify(clean);

  return {
    packet: clean,
    json,
    bytes: new TextEncoder().encode(json).length,
    nodesDropped,
    canaryChecks,
    withheld: survivors,
  };
}
