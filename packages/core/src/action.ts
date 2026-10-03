/**
 * Action schema: the contract between the remote planner and the local executor.
 *
 * Deliberately close to the WebArena / BrowserGym action space so the agent can
 * be evaluated against existing benchmarks without a translation layer.
 *
 * The privacy-critical design decision lives in `ValueRef`. A `type` action
 * carries a *reference* to a value, not the value itself. The server reasons
 * over `AADHAAR_1` and emits `type(el_7, placeholder AADHAAR_1)`; the client
 * resolves that against the local vault at execution time. The real digits are
 * never in a request body, a response body, or a server log.
 */

import type { Point } from './geometry.ts';
import type { ElementId } from './element.ts';
import type { PiiType } from './pii.ts';

/**
 * A value to enter into a field.
 *
 * `literal` is legal only for non-sensitive text the model genuinely composed
 * (a search query, a subject line). `placeholder` is the only form permitted
 * for anything the vault owns.
 */
export type ValueRef =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'placeholder'; readonly placeholderId: string };

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/** Categories the agent may ask the user to supply mid-task. */
export type UserInputCategory =
  | 'otp'
  | 'captcha'
  | 'password'
  | 'security_answer'
  | 'missing_profile_field'
  | 'confirmation'
  | 'other';

export interface ActionBase {
  /** Model's stated reason. Useful for the audit trail and for debugging. */
  readonly reasoning?: string;
  /** Model's self-reported confidence, 0..1. Advisory only; never trusted. */
  readonly confidence?: number;
}

export interface ClickAction extends ActionBase {
  readonly type: 'click';
  readonly target: ElementId;
}

/**
 * Coordinate click, produced by the grounder stage when the element graph
 * cannot resolve a target: image-only buttons, canvas widgets, table-soup
 * markup with no semantics. Still subject to the overlay check before dispatch.
 */
export interface ClickPointAction extends ActionBase {
  readonly type: 'click_point';
  readonly point: Point;
}

export interface TypeAction extends ActionBase {
  readonly type: 'type';
  readonly target: ElementId;
  readonly value: ValueRef;
  /** Press Enter after typing. */
  readonly submit?: boolean;
  /** Clear the field first. */
  readonly clear?: boolean;
}

export interface HoverAction extends ActionBase {
  readonly type: 'hover';
  readonly target: ElementId;
}

export interface SelectAction extends ActionBase {
  readonly type: 'select';
  readonly target: ElementId;
  readonly option: ValueRef;
}

export interface ScrollAction extends ActionBase {
  readonly type: 'scroll';
  readonly direction: ScrollDirection;
  /** Pixels. Defaults to roughly one viewport when omitted. */
  readonly amount?: number;
  readonly target?: ElementId;
}

export interface KeyPressAction extends ActionBase {
  readonly type: 'key_press';
  /** Chord notation, e.g. `Enter`, `Escape`, `Control+a`. */
  readonly keys: string;
}

export interface GotoUrlAction extends ActionBase {
  readonly type: 'goto_url';
  readonly url: string;
}

export interface GoBackAction extends ActionBase {
  readonly type: 'go_back';
}

export interface GoForwardAction extends ActionBase {
  readonly type: 'go_forward';
}

/**
 * Ask the user for something the agent does not have, then continue.
 *
 * This is the "ask, don't stop" channel. The server names a *category* and
 * never receives the answer: the client prompts, holds the value locally, and
 * substitutes it at execution time.
 */
export interface RequestUserInputAction extends ActionBase {
  readonly type: 'request_user_input';
  readonly category: UserInputCategory;
  /** Shown to the user. Must not contain page-derived secrets. */
  readonly reason: string;
  /** Handle the follow-up action will reference. */
  readonly placeholderId: string;
  readonly piiType?: PiiType;
}

export interface StopAction extends ActionBase {
  readonly type: 'stop';
  readonly answer: string;
  readonly success?: boolean;
}

export interface NoopAction extends ActionBase {
  readonly type: 'noop';
}

export type AgentAction =
  | ClickAction
  | ClickPointAction
  | TypeAction
  | HoverAction
  | SelectAction
  | ScrollAction
  | KeyPressAction
  | GotoUrlAction
  | GoBackAction
  | GoForwardAction
  | RequestUserInputAction
  | StopAction
  | NoopAction;

export type ActionType = AgentAction['type'];

export const ALL_ACTION_TYPES: readonly ActionType[] = [
  'click',
  'click_point',
  'type',
  'hover',
  'select',
  'scroll',
  'key_press',
  'goto_url',
  'go_back',
  'go_forward',
  'request_user_input',
  'stop',
  'noop',
] as const;

/** Actions that end the agent loop. */
export function isTerminal(action: AgentAction): boolean {
  return action.type === 'stop';
}

/** Actions that mutate page state, as opposed to observing or navigating. */
export function mutatesPage(action: AgentAction): boolean {
  switch (action.type) {
    case 'click':
    case 'click_point':
    case 'type':
    case 'select':
    case 'key_press':
      return true;
    default:
      return false;
  }
}

/** Does this action target a specific element in the graph? */
export function targetOf(action: AgentAction): ElementId | undefined {
  switch (action.type) {
    case 'click':
    case 'type':
    case 'hover':
    case 'select':
      return action.target;
    case 'scroll':
      return action.target;
    default:
      return undefined;
  }
}

/** Does this action carry a value that must be resolved from the vault? */
export function placeholderRefOf(action: AgentAction): string | undefined {
  if (action.type === 'type' && action.value.kind === 'placeholder') {
    return action.value.placeholderId;
  }
  if (action.type === 'select' && action.option.kind === 'placeholder') {
    return action.option.placeholderId;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Placeholder catalogue
// ---------------------------------------------------------------------------

/**
 * The redaction scheme, shared with the server so it can reason about masked
 * values. The PS requires the server be "aware of this redaction scheme"; this
 * catalogue is that contract, and it is the only thing the server learns about
 * the user's data.
 *
 * Carries the shape of a value, never the value.
 */
export interface PlaceholderEntry {
  readonly placeholderId: string;
  readonly piiType: PiiType;
  /** Human-readable hint, e.g. "12-digit Aadhaar number". No real data. */
  readonly description: string;
  /** Whether the client can supply this without asking the user. */
  readonly available: boolean;
  /** Number of times this value appears on the current screen. */
  readonly occurrences: number;
}

export interface PlaceholderCatalogue {
  readonly schemaVersion: 1;
  readonly entries: readonly PlaceholderEntry[];
}

export function emptyCatalogue(): PlaceholderCatalogue {
  return { schemaVersion: 1, entries: [] };
}

export function lookupPlaceholder(
  catalogue: PlaceholderCatalogue,
  placeholderId: string,
): PlaceholderEntry | undefined {
  return catalogue.entries.find((e) => e.placeholderId === placeholderId);
}

// ---------------------------------------------------------------------------
// Validation verdicts
// ---------------------------------------------------------------------------

/**
 * Why the local validator refused a server action.
 *
 * Every one of these is a real defence, not defensive boilerplate:
 * a hijacked or hallucinating model reaches the executor through this gate.
 */
export type ValidationFailureCode =
  /** Malformed JSON, unknown action type, missing required field. */
  | 'schema'
  /** Target element ID is not in the current graph (stale observation). */
  | 'unknown_target'
  /** Target exists but is disabled, hidden, or has a zero-size box. */
  | 'not_interactable'
  /** Something else sits on top of the target's centre point. Clickjacking. */
  | 'obscured'
  /** Navigation target is outside the allowed origin list. */
  | 'url_not_allowed'
  /** Too many actions in the window. Limits blast radius if hijacked. */
  | 'rate_limited'
  /** Placeholder is not in the catalogue or the vault cannot resolve it. */
  | 'unresolvable_placeholder'
  /** Secret aimed at a field whose semantics do not match. Bait-field attack. */
  | 'secret_target_mismatch'
  /**
   * The stored value belongs to a different site than the one on screen.
   *
   * This is the anti-phishing rule, and it is a refusal rather than a prompt on
   * purpose: asking "use your bank password on this look-alike?" puts the decision
   * on the person least equipped to spot a homograph domain at 2am. The credential
   * simply does not travel off its own origin.
   */
  | 'wrong_site';

export type ValidationVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: ValidationFailureCode;
      readonly detail: string;
    };

export function allow(): ValidationVerdict {
  return { ok: true };
}

export function refuse(code: ValidationFailureCode, detail: string): ValidationVerdict {
  return { ok: false, code, detail };
}
