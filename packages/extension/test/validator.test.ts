import { describe, expect, it } from 'vitest';
import {
  EMPTY_FLAGS,
  ELEMENT_GRAPH_SCHEMA_VERSION,
  type AgentAction,
  type ElementGraph,
  type ElementNode,
} from '@sih/core';
import {
  RATE_LIMIT_ACTIONS,
  validateAction,
  validateSequence,
  type ValidatorContext,
} from '../src/agent/validator.ts';
import type { EntryView } from '../src/vault/store.ts';

const ORIGIN = 'https://portal.example.edu';

function node(partial: Partial<ElementNode> & { id: string }): ElementNode {
  return {
    role: 'generic',
    name: '',
    rect: { x: 10, y: 10, width: 200, height: 30 },
    source: 'structure',
    confidence: 1,
    flags: { ...EMPTY_FLAGS, interactive: true },
    ...partial,
  };
}

function graphOf(nodes: readonly ElementNode[]): ElementGraph {
  return {
    schemaVersion: ELEMENT_GRAPH_SCHEMA_VERSION,
    url: `${ORIGIN}/login`,
    title: 'Login',
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    capturedAt: 1_700_000_000_000,
    nodes,
    stats: { structureCount: nodes.length, pixelCount: 0, fusedCount: 0, pixelOnlyCount: 0 },
  };
}

function entry(partial: Partial<EntryView> & { slot: string }): EntryView {
  return {
    piiType: 'password',
    label: 'Portal login',
    lifetime: 'session',
    length: 12,
    updatedAt: 0,
    usedOn: [],
    gated: true,
    ...partial,
  };
}

function ctx(partial: Partial<ValidatorContext> = {}): ValidatorContext {
  return {
    graph: graphOf([]),
    origin: ORIGIN,
    vault: [],
    suppliedPlaceholders: [],
    recentActionTimes: [],
    ...partial,
  };
}

const PASSWORD_FIELD = node({
  id: 'el_1',
  tag: 'input',
  inputType: 'password',
  name: 'Password',
  flags: { ...EMPTY_FLAGS, interactive: true, editable: true, focusable: true },
});

const SEARCH_FIELD = node({
  id: 'el_2',
  tag: 'input',
  inputType: 'search',
  name: 'Search',
  flags: { ...EMPTY_FLAGS, interactive: true, editable: true, focusable: true },
});

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

describe('target resolution', () => {
  /**
   * The model saw an older page. Guessing at a replacement target is how an agent
   * clicks the wrong thing, so a stale id is refused outright.
   */
  it('refuses a target that is no longer on the page', () => {
    const verdict = validateAction(
      { type: 'click', target: 'el_99' },
      ctx({ graph: graphOf([node({ id: 'el_1' })]) }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('unknown_target');
  });

  it('refuses a malformed target id', () => {
    const verdict = validateAction({ type: 'click', target: 'button.submit' }, ctx());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('schema');
  });

  it('accepts a pixel-channel target id', () => {
    const px = node({ id: 'px_0', source: 'pixel' });
    expect(
      validateAction({ type: 'click', target: 'px_0' }, ctx({ graph: graphOf([px]) })).ok,
    ).toBe(true);
  });

  it('refuses a disabled or hidden target', () => {
    const disabled = node({
      id: 'el_1',
      flags: { ...EMPTY_FLAGS, interactive: true, disabled: true },
    });
    const hidden = node({
      id: 'el_2',
      flags: { ...EMPTY_FLAGS, interactive: true, hidden: true },
    });

    for (const target of ['el_1', 'el_2']) {
      const verdict = validateAction(
        { type: 'click', target },
        ctx({ graph: graphOf([disabled, hidden]) }),
      );
      expect(verdict.ok, target).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe('not_interactable');
    }
  });

  /**
   * Something covering the target means a click lands on the covering element. From
   * the agent's perspective that is clickjacking, so it is a refusal.
   */
  it('refuses an obscured target', () => {
    const covered = node({
      id: 'el_1',
      flags: { ...EMPTY_FLAGS, interactive: true, obscured: true },
    });
    const verdict = validateAction(
      { type: 'click', target: 'el_1' },
      ctx({ graph: graphOf([covered]) }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('obscured');
  });

  it('refuses a coordinate click outside the viewport', () => {
    const verdict = validateAction({ type: 'click_point', point: { x: 5000, y: 10 } }, ctx());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('schema');
  });
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

describe('navigation', () => {
  /**
   * Where to go is the model's call. An origin allow-list here used to mean the user
   * had to pre-declare every site before the agent could reach it, which made
   * "search for X" impossible. What makes that safe to drop is that the model has
   * nothing worth exfiltrating — everything it saw was redacted first, and a
   * credential is refused on any site but its own.
   */
  it('allows any http origin, because choosing one is the model’s job', () => {
    expect(
      validateAction({ type: 'goto_url', url: 'https://duckduckgo.com/?q=ipl' }, ctx()).ok,
    ).toBe(true);
    expect(validateAction({ type: 'goto_url', url: `${ORIGIN}/marks` }, ctx()).ok).toBe(true);
  });

  /**
   * The scheme is still checked. `javascript:` is code execution in the page and
   * `file:` reads the disk; neither is navigation in any useful sense.
   */
  it('refuses a scheme that is not navigation', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
      const verdict = validateAction({ type: 'goto_url', url }, ctx());
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe('url_not_allowed');
    }
  });

  it('refuses a malformed URL', () => {
    const verdict = validateAction({ type: 'goto_url', url: 'not a url' }, ctx());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('schema');
  });
});

// ---------------------------------------------------------------------------
// Typing secrets — the part that matters
// ---------------------------------------------------------------------------

describe('typing secrets', () => {
  it('allows a literal into any editable field', () => {
    const action: AgentAction = {
      type: 'type',
      target: 'el_2',
      value: { kind: 'literal', text: 'attendance' },
    };
    expect(validateAction(action, ctx({ graph: graphOf([SEARCH_FIELD]) })).ok).toBe(true);
  });

  it('refuses a placeholder the vault cannot resolve', () => {
    const action: AgentAction = {
      type: 'type',
      target: 'el_1',
      value: { kind: 'placeholder', placeholderId: 'PASSWORD_NOPE' },
    };
    const verdict = validateAction(action, ctx({ graph: graphOf([PASSWORD_FIELD]) }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('unresolvable_placeholder');
  });

  it('refuses an ambiguous placeholder rather than guessing', () => {
    const action: AgentAction = {
      type: 'type',
      target: 'el_1',
      value: { kind: 'placeholder', placeholderId: 'PASSWORD_X' },
    };
    const verdict = validateAction(
      action,
      ctx({
        graph: graphOf([PASSWORD_FIELD]),
        vault: [entry({ slot: 'a' }), entry({ slot: 'b' })],
      }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('unresolvable_placeholder');
  });

  /**
   * The bait-field defence. A page can label a box anything; a password must land in
   * an actual password field, or it is also a shoulder-surfing leak.
   */
  it('refuses a password aimed at a search box', () => {
    const action: AgentAction = {
      type: 'type',
      target: 'el_2',
      value: { kind: 'placeholder', placeholderId: 'PASSWORD_PORTAL' },
    };
    const verdict = validateAction(
      action,
      ctx({
        graph: graphOf([SEARCH_FIELD]),
        vault: [entry({ slot: 'portal', usedOn: [ORIGIN] })],
      }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('secret_target_mismatch');
  });

  it('allows a password into a real password field on a known origin', () => {
    const action: AgentAction = {
      type: 'type',
      target: 'el_1',
      value: { kind: 'placeholder', placeholderId: 'PASSWORD_PORTAL' },
    };
    expect(
      validateAction(
        action,
        ctx({
          graph: graphOf([PASSWORD_FIELD]),
          vault: [entry({ slot: 'portal', usedOn: [ORIGIN] })],
        }),
      ).ok,
    ).toBe(true);
  });

  /**
   * Site binding is the anti-phishing rule, and it is a refusal rather than a prompt.
   * A dialog asking "use your portal password on this site?" puts the decision on the
   * person least able to spot a homograph domain, and in practice trains them to
   * click through. A bound credential simply does not travel off its own origin.
   */
  it('refuses a credential on a site it does not belong to', () => {
    const action: AgentAction = {
      type: 'type',
      target: 'el_1',
      value: { kind: 'placeholder', placeholderId: 'PASSWORD_PORTAL' },
    };
    const verdict = validateAction(
      action,
      ctx({
        graph: graphOf([PASSWORD_FIELD]),
        vault: [entry({ slot: 'portal', site: 'https://portal.exarnple.edu' })],
      }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('wrong_site');
  });

  it('uses a credential silently on the site it belongs to', () => {
    const action: AgentAction = {
      type: 'type',
      target: 'el_1',
      value: { kind: 'placeholder', placeholderId: 'PASSWORD_PORTAL' },
    };
    expect(
      validateAction(
        action,
        ctx({
          graph: graphOf([PASSWORD_FIELD]),
          vault: [entry({ slot: 'portal', site: ORIGIN })],
        }),
      ).ok,
    ).toBe(true);
  });

  /**
   * An unbound credential is allowed through, and the executor binds it to whatever
   * origin it lands on. First use is no more exposed than the user typing it in
   * themselves; every use after that is checked.
   */
  it('allows an unbound credential and leaves binding to the executor', () => {
    const action: AgentAction = {
      type: 'type',
      target: 'el_1',
      value: { kind: 'placeholder', placeholderId: 'PASSWORD_PORTAL' },
    };
    expect(
      validateAction(
        action,
        ctx({
          graph: graphOf([PASSWORD_FIELD]),
          vault: [entry({ slot: 'portal' })],
        }),
      ).ok,
    ).toBe(true);
  });

  /**
   * A value the user just typed in response to a prompt bypasses the stored-credential
   * checks: they chose where it was going.
   */
  it('allows a user-supplied value without the credential checks', () => {
    const action: AgentAction = {
      type: 'type',
      target: 'el_2',
      value: { kind: 'placeholder', placeholderId: 'OTP_1' },
    };
    expect(
      validateAction(
        action,
        ctx({ graph: graphOf([SEARCH_FIELD]), suppliedPlaceholders: ['OTP_1'] }),
      ).ok,
    ).toBe(true);
  });

  it('refuses typing into a non-editable element', () => {
    const button = node({ id: 'el_3', role: 'button', name: 'Submit' });
    const action: AgentAction = {
      type: 'type',
      target: 'el_3',
      value: { kind: 'literal', text: 'x' },
    };
    const verdict = validateAction(action, ctx({ graph: graphOf([button]) }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('not_interactable');
  });
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

describe('budgets', () => {
  /**
   * There is deliberately no step cap. It cut off long but legitimate tasks while
   * doing nothing about the failure that actually happens — a model looping on one
   * action — which the loop now detects directly by fingerprinting (action,
   * observation) pairs. What is left here is the rate limit.
   *
   * A runaway loop is bounded before it can act, not after: the check runs ahead of
   * anything that touches page state for exactly that reason.
   */
  it('rate limits a burst of actions', () => {
    // Sized from the constant rather than a literal. The ceiling had to be raised when
    // the model gained the ability to propose a sequence — filling an eight-field form
    // section is now one legitimate turn that dispatches eight actions — and a hardcoded
    // 12 here would have kept passing while silently testing nothing.
    const now = Date.now();
    const burst = Array.from({ length: RATE_LIMIT_ACTIONS }, (_, i) => now - i * 10);
    const verdict = validateAction({ type: 'noop' }, ctx({ recentActionTimes: burst }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('rate_limited');
  });

  /** A legitimate full batch must not trip it. That was the point of raising the cap. */
  it('allows a full batch of actions', () => {
    const now = Date.now();
    const batch = Array.from({ length: 8 }, (_, i) => now - i * 10);
    expect(validateAction({ type: 'noop' }, ctx({ recentActionTimes: batch })).ok).toBe(true);
  });

  it('ignores actions outside the rate-limit window', () => {
    const old = Array.from({ length: 30 }, (_, i) => Date.now() - 60_000 - i * 100);
    expect(validateAction({ type: 'noop' }, ctx({ recentActionTimes: old })).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------

describe('validateSequence', () => {
  it('reports the index of the first refusal', () => {
    const actions: AgentAction[] = [
      { type: 'noop' },
      { type: 'click', target: 'el_missing' },
      { type: 'noop' },
    ];
    const result = validateSequence(actions, ctx({ graph: graphOf([node({ id: 'el_1' })]) }));
    expect(result.index).toBe(1);
    expect(result.verdict.ok).toBe(false);
  });

  it('accepts a fully valid sequence', () => {
    const actions: AgentAction[] = [{ type: 'noop' }, { type: 'scroll', direction: 'down' }];
    const result = validateSequence(actions, ctx());
    expect(result.verdict.ok).toBe(true);
    expect(result.index).toBe(2);
  });

  /**
   * Refusal is positional: the reported index is the action that failed, not the
   * length of the batch, so a caller can send the prefix that was accepted.
   */
  it('stops at the first bad action rather than validating the rest', () => {
    const actions: AgentAction[] = [
      { type: 'noop' },
      { type: 'goto_url', url: 'javascript:alert(1)' },
      { type: 'noop' },
    ];
    const result = validateSequence(actions, ctx());
    expect(result.verdict.ok).toBe(false);
    expect(result.index).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pass-through actions
// ---------------------------------------------------------------------------

describe('non-page actions', () => {
  it('always allows asking the user for input', () => {
    expect(
      validateAction(
        {
          type: 'request_user_input',
          category: 'otp',
          reason: 'the portal sent a code',
          placeholderId: 'OTP_1',
        },
        ctx(),
      ).ok,
    ).toBe(true);
  });

  it('allows stop and noop', () => {
    expect(validateAction({ type: 'stop', answer: 'done' }, ctx()).ok).toBe(true);
    expect(validateAction({ type: 'noop' }, ctx()).ok).toBe(true);
  });

  it('refuses an empty key chord', () => {
    const verdict = validateAction({ type: 'key_press', keys: '  ' }, ctx());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('schema');
  });
});
