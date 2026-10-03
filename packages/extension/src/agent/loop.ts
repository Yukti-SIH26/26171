import {
  containment,
  slotToken,
  ELEMENT_GRAPH_NODE_CAP,
  type AgentAction,
  type ElementGraph,
  type PiiType,
  type PlatformAdapters,
  type ProviderSettings,
  type Rect,
} from '@sih/core';
import { classifyElement } from '../pii/structural.ts';
import {
  containsKnownValue,
  detectPii,
  outboundTextIsSafe,
  safeOrigin,
  sanitizeOutboundText,
  type KnownValue,
  type PiiFinding,
  type SensitiveTextMatch,
} from '../pii/index.ts';
import {
  annotateRegions,
  buildEgressPacket,
  planRedaction,
  redactImage,
  type EgressPacket,
  type WithheldField,
} from '../redact/index.ts';
import { observeWithMetrics } from '../platform/observe-via-content.ts';
import { historyAndWait, navigateAndWait, settleAfterAction } from '../platform/navigate.ts';
import { NotScriptableError } from '../platform/inject.ts';
import { DownloadTracker } from '../platform/downloads.ts';
import { KEY_SLOT } from '../llm/settings.ts';
import {
  describeRoute,
  recallRoute,
  rememberRoute,
  type Route,
  type RouteStep,
} from './routes.ts';
import { fuseChannels } from '../perception/fusion.ts';
import { loadDetector, isDetectorLoaded, observePixels } from '../models/vision.ts';
import { OWLVIT_BASE32 } from '../models/catalogue.ts';
import {
  buildMessages,
  chat,
  parseAction,
  planTask,
  ProviderError,
  readApiKey,
} from '../llm/index.ts';
import type { ChatMessage } from '../llm/client.ts';
import type { OcrWord } from '../models/ocr.ts';
import * as vault from '../vault/index.ts';
import {
  executeAction,
  piiTypeFromToken,
  SuppliedValues,
  type StepRecord,
} from './executor.ts';
import { validateAction, type ValidatorContext } from './validator.ts';

export type LoopPhase =
  | 'idle'
  | 'looking'
  | 'hiding'
  | 'thinking'
  | 'acting'
  | 'asking'
  | 'done'
  | 'stopped'
  | 'failed';

/**
 * How a line reads in the chat.
 *
 *   step  what the agent is doing right now — the ordinary case
 *   note  quieter context, e.g. what was hidden before sending
 *   warn  something did not work but the task continues
 *   bad   the task is over
 */
export type SayTone = 'step' | 'note' | 'warn' | 'bad';

/** One step's visual and byte record, for the audit tab. */
export interface AuditSnapshot {
  readonly step: number;
  /** Raw frame plus detection boxes. Local only — contains unredacted pixels. */
  readonly annotatedScreenshot?: string;
  /** What actually goes out. */
  readonly redactedScreenshot?: string;
  /** The sanitized packet, exactly as serialised, so it can be read in full. */
  readonly packetJson: string;
  /** Bytes actually put on the wire for this step, image included. */
  readonly bytes: number;
  /** One row per kind of thing hidden: what it was and how it was covered. */
  readonly hidden: readonly HiddenItem[];
  /**
   * Fields emptied because a value was still readable in them after redaction.
   *
   * Normally empty. When it is not, it is the honest record of a place the redactor
   * could not clean and therefore withheld, which belongs in the audit trail rather
   * than only in a console warning.
   */
  readonly withheld: readonly WithheldField[];
  readonly withheldScreenshot: boolean;
  readonly url: string;
}

/** A single kind of thing that was found and hidden, described without its value. */
export interface HiddenItem {
  /** e.g. "aadhaar". */
  readonly what: string;
  /** e.g. "covered with a solid block". */
  readonly how: string;
  /** How it was recognised. */
  readonly foundBy: string;
  /** How many of this kind, when more than one. */
  readonly count?: number;
}

export interface LoopCallbacks {
  readonly onPhase: (phase: LoopPhase, detail: string) => void;
  /** One plain line for the chat. Never contains a secret value. */
  readonly onSay: (line: string, tone?: SayTone) => void;
  readonly onAudit: (audit: AuditSnapshot) => void;
  /**
   * Ask the user for one missing value, inline in the chat.
   *
   * `details` is what makes the question answerable. Without it the panel only knew the
   * category, and almost everything the agent needs is one category — so a request for a
   * first name rendered as a masked box labelled "Missing detail", which is not a question
   * anyone can answer.
   */
  readonly requestInput: (
    category: string,
    reason: string,
    placeholderId: string,
    details?: {
      /** The kind of value, when it could be worked out. Drives the field label. */
      readonly piiType?: string;
      /** The page's own label for the box, e.g. `First Name`. */
      readonly fieldName?: string;
      /** Host it will be used on. */
      readonly site?: string;
    },
  ) => Promise<string | undefined>;
  readonly requestPassphrase: () => Promise<string | undefined>;
}

export interface LoopOptions {
  readonly task: string;
  readonly tabId: number;
  readonly platform: PlatformAdapters;
  readonly settings: ProviderSettings;
  readonly callbacks: LoopCallbacks;
  readonly signal: AbortSignal;
}

export interface LoopResult {
  readonly finished: boolean;
  readonly answer?: string;
  readonly steps: readonly StepRecord[];
  readonly reason: string;
  readonly bytesSent: number;
  /** True when `reason` was already said in the chat, so callers do not repeat it. */
  readonly reasonAlreadyLogged: boolean;
}

/**
 * How many times the same action on the same unchanged page means stuck.
 *
 * Three, because two is a legitimate retry — a click that missed while the page was
 * still settling is normal, and cutting off at two would break real tasks.
 */
const REPEAT_LIMIT = 3;

/**
 * Cap on proposing the same action across the whole task, whatever the screen looks like.
 *
 * A second tier, because the first one can be evaded without anybody intending to. It
 * keys on (action, screen), so a page that keeps changing underneath — an advert
 * arriving, a suggestion list opening — produces a fresh bucket every time and the same
 * click can repeat indefinitely with a count of one.
 *
 * Six is deliberately generous. Clicking "Next" through pagination is the same signature
 * legitimately, and that has to keep working; what this catches is the case where
 * nothing is moving at all. The counter resets on real navigation, so six is six
 * attempts on one page rather than six for the whole run.
 */
const REPEAT_LIMIT_TOTAL = 6;

/**
 * The one sentence shown when local vision cannot run.
 *
 * Deliberately short and identical everywhere. The ONNX Runtime message it replaces
 * ran to three lines of build paths and C++ internals in the chat window, which tells
 * the person using this nothing they can act on. The full error still goes to the
 * console, where somebody debugging will look.
 */
const VISION_FAILED = 'I could not start the on-device vision model.';

/**
 * Longest edge of the screenshot that is actually transmitted.
 *
 * Chosen as "about one CSS-pixel viewport", not as an arbitrary quality setting. A
 * capture on a 2x display is 2300 px wide for a 1150 px page, so the extra pixels carry
 * no extra text — the user is reading the same glyphs at the same apparent size. Sending
 * them cost roughly four times the bytes and a proportional amount of upload time on
 * every single step.
 *
 * The Audit tab keeps the full-resolution masked frame regardless, because there the
 * whole point is being able to see that a mask covers what it claims to.
 */
const WIRE_MAX_EDGE = 1280;

// ---------------------------------------------------------------------------
// Did that work?
// ---------------------------------------------------------------------------

/**
 * What the last step was supposed to change, recorded so the next read can check.
 *
 * Executing an action successfully is not the same as the action achieving anything, and
 * the loop used to conflate the two: the executor reported "clicked el_30, done", the
 * page silently refused, and the next turn started from scratch with no idea that the
 * previous one had accomplished nothing. The repeat guard eventually noticed, but only
 * after the same thing had been tried three times.
 *
 * Everything here is measured *before* the action runs, so the comparison afterwards is
 * against a known starting point rather than against an assumption.
 */
interface Expectation {
  readonly action: AgentAction;
  /** Origin and path, the part of the URL that says whether we went anywhere. */
  readonly place: string;
  /** Cheap hash of what was on screen. */
  readonly shape: string;
  /** Fields text was typed into this step, so a rejection can be attributed. */
  readonly typedInto: readonly string[];
  /** Ids already being rejected, so only *new* rejections are reported. */
  readonly rejected: readonly string[];
  /** Notices already showing, so only *new* ones are reported. */
  readonly notices: readonly string[];
}

/** Roles a page uses to say something went wrong or something changed. */
const NOTICE_ROLES = new Set(['alert', 'alertdialog', 'status']);

function noticeTexts(graph: ElementGraph | undefined): string[] {
  if (graph === undefined) return [];
  const out: string[] = [];
  for (const node of graph.nodes) {
    if (!NOTICE_ROLES.has(node.role)) continue;
    const text = (node.text ?? node.name).trim();
    if (text !== '') out.push(text.slice(0, 200));
  }
  return out;
}

function rejectedIds(graph: ElementGraph | undefined): string[] {
  return graph === undefined
    ? []
    : graph.nodes.filter((n) => n.invalid === true).map((n) => n.id);
}

/**
 * A hash of the ids, roles and names on screen.
 *
 * Used only to detect that nothing changed, which makes its sensitivity safe in the one
 * direction that matters. A page whose adverts reshuffle between reads hashes
 * differently and the check simply stays quiet; it can miss a stalled click, but it
 * cannot invent one. The same sensitivity is why this is not reused for the repeat
 * guard, where being fooled by jitter meant never counting a repeat at all.
 */
function pageShape(graph: ElementGraph | undefined): string {
  if (graph === undefined) return 'blind';
  let hash = 0;
  for (const node of graph.nodes) {
    const key = `${node.id}|${node.role}|${node.name}`;
    for (let i = 0; i < key.length; i++) hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  }
  return `${String(graph.nodes.length)}:${String(hash)}`;
}

/**
 * Should this action have visibly altered the page?
 *
 * Typing and selecting change a value, not the set of elements, so asking "did the page
 * change" of them would report every successful keystroke as a failure. Hovering is
 * expected to do nothing at all.
 */
function expectsVisibleChange(action: AgentAction): boolean {
  switch (action.type) {
    case 'click':
    case 'click_point':
    case 'goto_url':
    case 'go_back':
    case 'go_forward':
    case 'key_press':
    case 'scroll':
      return true;
    case 'type':
      return action.submit === true;
    default:
      return false;
  }
}

/**
 * Compare what happened with what was supposed to happen.
 *
 * Ordered by how specific the evidence is. A named field being rejected tells the model
 * exactly what to change; a new banner tells it where to look; "nothing moved" tells it
 * only that the last idea was wrong. Reporting the most specific available finding keeps
 * the hint actionable instead of vague.
 *
 * `sanitize` is not optional. Validation messages and banner text come from the page
 * unredacted — a portal that answers a wrong roll number with "21CS042 is not
 * registered" hands back the value in its complaint — and this hint goes into the next
 * outbound prompt.
 */
function checkOutcome(
  expectation: Expectation,
  graph: ElementGraph | undefined,
  url: string,
  sanitize: (text: string) => string,
): { readonly hint: string; readonly note: string } | undefined {
  const alreadyRejected = new Set(expectation.rejected);
  const fresh = (graph?.nodes ?? []).filter(
    (node) => node.invalid === true && !alreadyRejected.has(node.id),
  );
  // Prefer a field this step actually touched; fall back to any newly rejected field,
  // since a submit is what usually makes the whole form light up at once.
  const culprit = fresh.find((node) => expectation.typedInto.includes(node.id)) ?? fresh[0];
  if (culprit !== undefined) {
    const reason = culprit.validationMessage;
    return {
      hint:
        `The page is now refusing ${culprit.id}` +
        (reason === undefined ? '.' : `: "${sanitize(reason)}".`) +
        ' Put something different in that field. Submitting again unchanged will fail the ' +
        'same way.',
      note: `the page refused ${culprit.id}`,
    };
  }

  const alreadySaid = new Set(expectation.notices);
  const newNotice = noticeTexts(graph).find((text) => !alreadySaid.has(text));
  if (newNotice !== undefined) {
    return {
      hint:
        `The page put up a new message after that step: "${sanitize(newNotice)}". Respond to what ` +
        'it says instead of repeating the last action.',
      note: 'the page showed a new message',
    };
  }

  if (!expectsVisibleChange(expectation.action)) return undefined;

  const place = `${safeOrigin(url)}|${pathOf(url)}`;
  if (place === expectation.place && pageShape(graph) === expectation.shape) {
    // A scroll that moves nothing means the page is already as far as it goes, which is
    // useful information rather than a failure. Saying "that did not work, try something
    // else" about it sends the agent looking for a different way to scroll.
    if (expectation.action.type === 'scroll') {
      return {
        hint:
          'That scroll did not move the page — you are already at the end of it. Everything ' +
          'there is to see is in this view.',
        note: 'the page would not scroll any further',
      };
    }
    return {
      hint:
        `That ${expectation.action.type.replace(/_/g, ' ')} changed nothing — same address, same ` +
        'page, same elements. It did not work. Choose a different element or a different route ' +
        'rather than trying it again.',
      note: 'the last action changed nothing',
    };
  }

  return undefined;
}

/**
 * Longest we are willing to wait for the page to settle after this action.
 *
 * A ceiling, not a duration. `settleAfterAction` asks the page when it has stopped
 * changing and returns as soon as it says so, so these numbers are only reached by a page
 * that never goes quiet — a carousel, a clock, a long-polling widget. That is why they
 * are larger than the fixed sleeps they replace: a generous ceiling now costs nothing on
 * an ordinary page, whereas the old 700 ms was spent on every single click whether the
 * page needed it or not.
 */
function settleBudgetFor(action: AgentAction): number {
  switch (action.type) {
    case 'click':
    case 'click_point':
      return 1500;
    case 'type':
      return action.submit === true ? 2500 : 400;
    case 'select':
    case 'key_press':
      return 1200;
    case 'scroll':
      return 400;
    default:
      return 150;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'about:blank';
  }
}

/** Site name as a person would say it: `digilocker.gov.in`, not the whole URL. */
function siteName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Words that are a description of a site rather than anybody's actual domain.
 *
 * Kept to generic role nouns only. The test is on the registrable name, so a real
 * product whose name happens to contain one of these — `openrouter.ai`, `portalnews.com`
 * — is unaffected; `erp.college.edu` and `portal.university.edu` are not.
 */
export const GENERIC_SITE_WORDS =
  /^(?:college|university|institute|school|campus|erp|portal|student|exam|results?|admin|login|account|bank|website|site|company|example|mysite|myportal|mycollege)$/;

export function looksInvented(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return true;
  }

  const labels = host.split('.');
  if (labels.length < 2) return true;

  // The last label, which on a real address is a public suffix — `com`, `in`, `gov.in`,
  // `edu`. `collegeerp.portal` and `myclgerp.login` both slipped through the registrable
  // check below because their *made-up* part is the suffix: there is no `.portal` and no
  // `.login` TLD, and nothing in a role noun like "portal" or "login" is ever one.
  const suffix = labels[labels.length - 1];
  if (suffix !== undefined && GENERIC_SITE_WORDS.test(suffix)) return true;

  // `example.com` -> `example`; `erp.college.edu` -> `college`.
  const registrable = labels[labels.length - 2];
  return registrable !== undefined && GENERIC_SITE_WORDS.test(registrable);
}

/**
 * Filler the model writes when it is describing a value instead of supplying one.
 *
 * This is what put the literal words "your college name" into a search box: the plan
 * carried a template phrase and the action copied it verbatim. Typing a description of
 * a value is never useful, so it is refused locally and the model is told to use the
 * user's own words.
 */
const FILLER_TEXT =
  // `your` on its own, anywhere in the string. It was previously required to be followed
  // immediately by one noun from a list, so "your account name" and "enter your roll
  // number here" both went straight into the field — two words after the possessive
  // instead of one. Widening the list would not have fixed it; the tell is the word
  // itself. Nothing the user actually stores or searches for is addressed to them in the
  // second person, whereas every hint text a model writes is.
  /\byour\b|(?:^|\b)(?:my|the)\s+(?:college|university|institute|school|company|bank|site|website|portal|name|username|email|password|value|query|search\s*term)\b|<[^>]{2,40}>|\[[^\]]{2,40}\]|\b(?:e\.?g\.?|for\s+example|placeholder|lorem\s+ipsum|xxx+|abc123)\b/i;

/**
 * A handle, written as if it were text to type.
 *
 * Seen in a live run: `type(el, literal "API_KEY_PROVIDER_KEY")`. A handle names a value
 * held on this machine; typed literally it enters the token itself into the page, which
 * is both useless and confusing to whatever reads that field. The value form is
 * `{"kind":"placeholder","placeholderId":"…"}`, and the model is told so.
 */
const HANDLE_LIKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

export function isFillerText(text: string): boolean {
  const trimmed = text.trim();
  return FILLER_TEXT.test(trimmed) || HANDLE_LIKE.test(trimmed);
}

/** Browser-internal pages cannot be scripted by any extension, ever. */
function isReadableUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

async function currentUrl(tabId: number): Promise<string> {
  try {
    const { browser } = await import('wxt/browser');
    const tab = await browser.tabs.get(tabId);
    return tab.url ?? 'about:blank';
  } catch {
    return 'about:blank';
  }
}

// ---------------------------------------------------------------------------
// Saying what is happening, in words
// ---------------------------------------------------------------------------

/**
 * May the batch keep going after this action?
 *
 * The whole batch is validated against one element graph, so the question is whether
 * this action could have invalidated it. Filling a text field or picking from a select
 * leaves the page structurally where it was; anything that submits, navigates, or
 * activates a control does not, and a stale graph is how an agent clicks something that
 * is no longer there.
 *
 * Erring towards stopping is cheap — it costs one extra observation — while erring the
 * other way means acting on a page that has moved on.
 */
function batchContinuesAfter(action: AgentAction): boolean {
  switch (action.type) {
    case 'type':
      // `submit` presses Enter, which is a form submission in all but name.
      return action.submit !== true;
    case 'select':
    case 'hover':
    case 'scroll':
      return true;
    default:
      return false;
  }
}

/**
 * What to say when the local checks refuse an action.
 *
 * Every refusal used to print the same sentence — "That did not work. Let me try another
 * way." — three and four times in a row, which told the user nothing and made a
 * recovering agent look broken. The reason is always known; it just was not being said.
 *
 * Phrased as what happened rather than which rule fired. A refusal code belongs in the
 * console and the audit trail; the chat gets the human consequence.
 */
function refusalLine(record: StepRecord): string | undefined {
  switch (record.refusedAs) {
    // Handled by the controller in the next few lines: it asks the user and carries on.
    // Announcing the refusal first made a normal part of filling a form read as a fault —
    // "That box is not asking for what I was about to type, so I stopped." is alarming,
    // unexplained, and immediately contradicted by the question that follows it.
    case 'secret_target_mismatch':
    case 'unresolvable_placeholder':
      return undefined;

    // Ordinary page movement. Worth one calm line, because the step after it will look
    // like a repeat otherwise.
    case 'unknown_target':
      return 'The page moved. Reading it again.';
    case 'not_interactable':
      return 'Looking for another way to do that.';
    case 'schema':
      return 'Reading the page again.';

    // Something was actually prevented, and the user should know.
    case 'obscured':
      return 'Something is covering that, so I did not click through it.';
    case 'wrong_site':
      return 'That saved detail belongs to a different site, so I did not use it here.';
    case 'url_not_allowed':
      return 'That link does not go to a normal web page, so I skipped it.';

    case 'rate_limited':
      return 'Slowing down for a moment.';
    default:
      // No invented explanation. The console and the Audit tab carry the real reason; a
      // vague "that did not work" in the chat only tells the user something is wrong.
      return 'Trying another way.';
  }
}

/**
 * What kind of value does this field want?
 *
 * Asked of the *element*, not of the token the model made up. A live run had the model
 * propose `FIRST_NAME_LOCAL_A` — a handle nobody issued, for a type that does not exist —
 * so deriving the type from the token gave `undefined`, and the user was asked for their
 * "details" with no indication of what was wanted. The field itself knew: it carried
 * `autocomplete="given-name"`.
 *
 * The token is still tried first, because when the model *does* name a real handle that is
 * the most precise answer available.
 */
function wantedType(
  graph: ElementGraph | undefined,
  targetId: string | undefined,
  placeholderId: string,
): PiiType | undefined {
  const fromToken = piiTypeFromToken(placeholderId);
  if (fromToken !== undefined) return fromToken;

  const node = targetId === undefined ? undefined : graph?.nodes.find((n) => n.id === targetId);
  if (node === undefined) return undefined;

  // The same structural detector the redactor and the validator use, so all three agree
  // about what a field is for.
  const signals = classifyElement(node)
    .filter((signal) => signal.confidence >= 0.5)
    .sort((a, b) => b.confidence - a.confidence);
  return signals[0]?.piiType;
}

/** The page's own label for a field, unquoted, for a sentence shown to the user. */
function plainFieldName(
  graph: ElementGraph | undefined,
  id: string | undefined,
): string | undefined {
  if (id === undefined) return undefined;
  const node = graph?.nodes.find((item) => item.id === id);
  if (node === undefined) return undefined;
  const label = node.name !== '' ? node.name : (node.placeholder ?? '');
  return label === '' ? undefined : label;
}

/** What a person would call this element, without quoting any value it holds. */
function nameOf(graph: ElementGraph | undefined, id: string): string {
  const node = graph?.nodes.find((item) => item.id === id);
  if (node === undefined) return 'the page';
  if (node.name !== '') return `"${node.name}"`;
  if (node.placeholder !== undefined && node.placeholder !== '') return `"${node.placeholder}"`;
  // "the generic" is what an unnamed container's ARIA role reads as, which is not
  // something to show a person.
  return node.flags.editable
    ? 'the field'
    : node.role === 'generic'
      ? 'the page'
      : `the ${node.role}`;
}

/**
 * Turn an action into something worth remembering about how this site works.
 *
 * Returns `undefined` for the steps that say nothing about the route: scrolling, hovering,
 * and asking the user a question are all things the next run will work out for itself.
 *
 * The label is the page's own word for the control, put through the redaction dictionary
 * on the way in. A stored route is therefore already sanitized, which is what makes
 * replaying it into an outbound prompt safe rather than a second thing to remember to
 * check.
 */
function routeStepFor(
  action: AgentAction,
  graph: ElementGraph | undefined,
  sanitize: (text: string) => string,
): RouteStep | undefined {
  if (action.type === 'goto_url') {
    // The address is not recorded; the origin on the route already carries it, and a full
    // URL can hold a session id. What is worth keeping is that the run started here.
    return { action: 'open the site' };
  }
  if (
    action.type !== 'click' &&
    action.type !== 'type' &&
    action.type !== 'select' &&
    action.type !== 'key_press'
  ) {
    return undefined;
  }

  const target = 'target' in action ? action.target : undefined;
  const node =
    target === undefined ? undefined : graph?.nodes.find((item) => item.id === target);
  const rawLabel =
    node === undefined ? '' : node.name !== '' ? node.name : (node.placeholder ?? '');
  const label = rawLabel === '' ? undefined : sanitize(rawLabel);

  return {
    action: action.type,
    ...(node?.role === undefined || node.role === 'generic' ? {} : { role: node.role }),
    ...(label === undefined ? {} : { label }),
  };
}

/**
 * Is it safe to show what is being typed into this field?
 *
 * Yes for a box the structural detector recognises as nothing in particular — a search
 * field, a message body, a quantity. No for anything it reads as identifying, which is
 * where a quoted value is both a small leak into an unredacted surface and, when the model
 * guessed, a fabricated value shown to the user as if it were theirs.
 */
function quotableField(graph: ElementGraph | undefined, id: string): boolean {
  const node = graph?.nodes.find((item) => item.id === id);
  if (node === undefined) return false;
  if (node.inputType === 'password') return false;
  return classifyElement(node).every((signal) => signal.confidence < 0.5);
}

/**
 * One plain line per step.
 *
 * Every action says something, because a panel that only says "Working" for a minute
 * reads as broken. What it never says is a stored value, a placeholder token, a refusal
 * code, or which detector fired — those belong in Audit and the console.
 */
function narrate(action: AgentAction, graph: ElementGraph | undefined): string {
  switch (action.type) {
    case 'goto_url':
      return `Opening ${siteName(action.url)}`;
    case 'go_back':
      return 'Going back a page';
    case 'go_forward':
      return 'Going forward a page';
    case 'click':
      return `Clicking ${nameOf(graph, action.target)}`;
    case 'click_point':
      return 'Clicking that part of the page';
    case 'hover':
      return `Hovering over ${nameOf(graph, action.target)}`;
    case 'type':
      // The text is quoted only for a field that is plainly not personal — a search box, a
      // subject line. For anything identity-shaped the label is enough.
      //
      // Two reasons, and the second is the one that was actually biting. Echoing a value
      // into the transcript puts it in a place nothing redacts. And this line is printed
      // *before* the action is checked, so when the model invented a name the chat read
      // "Typing “John” into "First Name"" — showing the user a fabricated value and
      // attributing it to them, for an action that was then refused anyway.
      return action.value.kind === 'literal'
        ? quotableField(graph, action.target)
          ? `Typing “${action.value.text}” into ${nameOf(graph, action.target)}`
          : `Filling in ${nameOf(graph, action.target)}`
        : `Filling in ${nameOf(graph, action.target)} from your saved details`;
    case 'select':
      return action.option.kind === 'literal'
        ? `Choosing “${action.option.text}” in ${nameOf(graph, action.target)}`
        : `Choosing your saved value in ${nameOf(graph, action.target)}`;
    case 'scroll':
      return action.direction === 'down'
        ? 'Scrolling down to see more'
        : `Scrolling ${action.direction}`;
    case 'key_press':
      return action.keys === 'Enter' ? 'Pressing Enter' : `Pressing ${action.keys}`;
    case 'request_user_input':
      return 'I need one detail from you';
    case 'stop':
      return action.answer;
    case 'noop':
      return 'Waiting a moment';
  }
}

/**
 * How many things that had to be covered in the picture were not.
 *
 * Two sources, because they fail differently. A finding is what policy decided to mask,
 * so an uncovered one means the plan and the paints disagree. A recognised word matching
 * a local value is the pixel-level ground truth: the model read it off the screen, so if
 * no rectangle sits over it, it would have gone out legible.
 */
function uncoveredSensitiveRegions(
  findings: readonly PiiFinding[],
  words: readonly OcrWord[],
  paints: readonly { readonly rect: Rect }[],
  known: readonly KnownValue[],
  viewport: { readonly width: number; readonly height: number },
): number {
  /**
   * Is any part of this region actually inside the picture?
   *
   * Real pages park elements far off-screen — Gmail does it by the dozen, at
   * coordinates like x = -10000 — and a region that is not in the frame cannot be
   * legible in the frame, so it needs no mask. Counting those as uncovered is what made
   * a heavy page throw its screenshot away: one hidden element nowhere near the viewport
   * was enough to fail the whole check.
   */
  const onScreen = (rect: Rect): boolean =>
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x + rect.width > 0 &&
    rect.y + rect.height > 0 &&
    rect.x < viewport.width &&
    rect.y < viewport.height;

  const covered = (rect: Rect): boolean =>
    paints.some((paint) => containment(rect, paint.rect) >= 0.97);

  let uncovered = 0;

  for (const finding of findings) {
    // A synthetic or placeholder substitution is a text-channel edit; the pixels are
    // only masked when the mode says so.
    if (finding.redaction !== 'mask_solid' && finding.redaction !== 'blur') continue;
    if (!onScreen(finding.rect)) continue;
    if (!covered(finding.rect)) uncovered++;
  }

  for (const word of words) {
    if (!containsKnownValue(word.text, known)) continue;
    if (!onScreen(word.rect)) continue;
    if (!covered(word.rect)) uncovered++;
  }

  return uncovered;
}

function mayStartRequestedDownload(
  action: AgentAction,
  graph: ElementGraph | undefined,
): boolean {
  if (action.type === 'click_point') return true;
  if (action.type !== 'click') return false;
  const node = graph?.nodes.find((item) => item.id === action.target);
  const label = `${node?.name ?? ''} ${node?.text ?? ''}`;
  return /\b(?:download|save|export|admit\s*card|hall\s*ticket|pdf)\b/i.test(label);
}

/**
 * A signature for repetition detection.
 *
 * Includes the value shape, so typing two different things into the same box is not
 * mistaken for a loop.
 */
function signatureOf(action: AgentAction): string {
  switch (action.type) {
    case 'click':
    case 'hover':
      return `${action.type}:${action.target}`;
    case 'click_point':
      return `click_point:${String(Math.round(action.point.x))},${String(Math.round(action.point.y))}`;
    case 'type':
      return `type:${action.target}:${
        action.value.kind === 'literal' ? action.value.text : action.value.placeholderId
      }`;
    case 'select':
      return `select:${action.target}:${
        action.option.kind === 'literal' ? action.option.text : action.option.placeholderId
      }`;
    case 'scroll':
      return `scroll:${action.direction}:${String(action.amount ?? 0)}`;
    case 'key_press':
      return `key:${action.keys}`;
    case 'goto_url':
      return `goto:${action.url}`;
    default:
      return action.type;
  }
}

/**
 * Where we are, coarsely — for deciding whether an action is going in circles.
 *
 * Deliberately blind to detail. A fine-grained hash of every node's text and value was
 * tried and it made the repeat detector useless: typing into a box changes that box's
 * value, a suggestion list changes the node count, `ensureVisible` changes the scroll
 * position. Every retry therefore landed in a fresh bucket with a count of one, so the
 * agent could press Enter four times and type the same query five times without ever
 * tripping the limit.
 *
 * Origin, title and the set of things you can act on is enough to say "this is still the
 * same screen" while ignoring the noise a page makes while you use it.
 */
function observationFingerprint(graph: ElementGraph | undefined, url: string): string {
  if (graph === undefined) return `blind:${safeOrigin(url)}`;
  return `${safeOrigin(graph.url)}|${pathOf(graph.url)}|${graph.title}`;
}

/**
 * Path without the query string.
 *
 * The set of actionable element ids used to be hashed into the fingerprint, and it was
 * still too sensitive: on a search results page the advertisements, the suggestion
 * dropdown and the lazily-loaded panels each add and remove actionable nodes between
 * turns, so every retry landed in a fresh bucket with a count of one. That is how
 * "Clicking ERP Login" fired three times in a row without the limit noticing.
 *
 * Origin, path and title is what "the same screen" actually means for this purpose.
 * Typing into a box does not change it, a late-loading advert does not change it, and
 * navigating somewhere does. The query is dropped because a search page rewrites it as
 * you type.
 */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}

// ---------------------------------------------------------------------------
// Reading the page
// ---------------------------------------------------------------------------

interface Frame {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

interface PageState {
  /** Absent when there is nothing readable in front of us. */
  readonly graph?: ElementGraph;
  readonly frame?: Frame;
  readonly words: readonly OcrWord[];
  readonly url: string;
  /** Why the page could not be read, in the wording shown to the user. */
  readonly unreadable?: string;
  /** Set when a capture was attempted and refused, for one honest line. */
  readonly captureNote?: string;
  /**
   * Why local visual screening could not run.
   *
   * Present only when the on-device vision pass failed. The turn does not continue:
   * the agent's accuracy depends on seeing the screen, and the privacy guarantee
   * depends on this pass having read it first.
   */
  readonly visionError?: string;
}

/**
 * Roles that mean "this box is a picture", for pages that declare it in ARIA rather
 * than in the tag. The tag-based answer arrives as `node.paintsImage`.
 */
const PICTURE_ROLES = new Set([
  'img',
  'image',
  'figure',
  'application',
  'graphics-document',
  'graphics-object',
  'graphics-symbol',
]);

/**
 * Smallest surface worth reading. Below roughly this, there is no legible glyph in it.
 */
const MIN_SURFACE_WIDTH = 16;
const MIN_SURFACE_HEIGHT = 10;

/**
 * Where in the frame text could be hiding from the DOM.
 *
 * Only what is actually on screen: a picture scrolled out of view is not in the
 * screenshot, so reading it would cost time and protect nothing. Everything returned is
 * in CSS pixels, the space the redaction rectangles live in.
 */
function rasterSurfaces(graph: ElementGraph): Rect[] {
  const out: Rect[] = [];
  for (const node of graph.nodes) {
    if (node.flags.hidden || !node.flags.inViewport) continue;
    if (node.paintsImage !== true && !PICTURE_ROLES.has(node.role)) continue;
    if (node.rect.width < MIN_SURFACE_WIDTH || node.rect.height < MIN_SURFACE_HEIGHT) continue;
    out.push(node.rect);
  }
  return out;
}

/**
 * Enough well-named controls that the detector has nothing to add.
 *
 * Ten is a page with a real navigation bar and a real form in it. Below that we are
 * plausibly looking at a canvas app, an image map, or unlabelled `div` soup, which is
 * precisely what the pixel channel exists for.
 */
const NAMED_ENOUGH = 10;

/** A picture this large is a UI, not an illustration, and needs looking at. */
const CANVAS_SHARE = 0.25;

function detectorWouldHelp(graph: ElementGraph, surfaces: readonly Rect[]): boolean {
  const viewportArea = Math.max(1, graph.viewport.width * graph.viewport.height);
  for (const surface of surfaces) {
    if ((surface.width * surface.height) / viewportArea >= CANVAS_SHARE) return true;
  }

  let named = 0;
  for (const node of graph.nodes) {
    if (!node.flags.interactive || node.flags.hidden || !node.flags.inViewport) continue;
    if (node.name.trim() === '') continue;
    named++;
    if (named >= NAMED_ENOUGH) return false;
  }
  return true;
}

/**
 * Build the fullest picture of the page available, and say honestly when there is
 * none.
 *
 * No page is a normal outcome, not an error: a new tab, a browser page, or a PDF
 * viewer all land here, and the model can still make progress from the task text
 * alone.
 */
async function readPage(tabId: number, platform: PlatformAdapters): Promise<PageState> {
  const url = await currentUrl(tabId);

  if (!isReadableUrl(url)) {
    return {
      url,
      words: [],
      unreadable: 'this tab is a browser page, which no extension is allowed to read',
    };
  }

  // ---- Picture first --------------------------------------------------
  // Captured before the DOM walk, not after. Redaction maps element rectangles onto
  // this frame, so the two have to describe the same moment; a page that re-renders in
  // between yields boxes that sit slightly off the text they are covering. The image is
  // the thing that cannot be re-derived later, so it goes first and the graph is read
  // against it.
  //
  // Optional throughout. Without a frame the structure channel still works, so a
  // refused or failed capture degrades the turn rather than ending it.
  let frame: Frame | undefined;
  let captureNote: string | undefined;

  // Captured on every turn, whatever the send setting says. The frame is what the Audit
  // tab shows with its masks drawn on, which is the only way a person can check what
  // would have left their screen. Whether it is *attached* to the request is decided
  // later, by the setting.
  if (platform.capture.isReady?.() !== false) {
    try {
      // High quality because this frame feeds the audit view, which people read and
      // project. What goes to the model is re-encoded smaller separately, so this costs
      // local memory for a step rather than bytes on the wire.
      const captured = await platform.capture.captureViewport(tabId, {
        format: 'jpeg',
        quality: 94,
      });
      frame = {
        dataUrl: captured.dataUrl,
        width: captured.width,
        height: captured.height,
        scale: captured.scale,
      };
    } catch (error) {
      captureNote = describe(error);
    }
  }

  let graph: ElementGraph;
  try {
    graph = (await observeWithMetrics(tabId, {})).graph;
  } catch (error) {
    // `NotScriptableError` already reads as a plain sentence about the page, so it goes
    // straight through to the model as the reason. Anything else is a fault rather than
    // a property of the page, so it is logged and summarised.
    if (!(error instanceof NotScriptableError)) {
      console.error('[yukti] could not read the page', error);
    }
    return {
      url,
      words: [],
      unreadable:
        error instanceof NotScriptableError ? error.message : 'the page reader did not respond',
    };
  }

  let words: readonly OcrWord[] = [];

  if (frame !== undefined) {
    // Scale is measured against the viewport the graph reported, which is the only
    // coordinate space the redaction rectangles live in.
    const measured = frame.width / Math.max(1, graph.viewport.width);
    frame = { ...frame, scale: measured };

    // Two separate decisions, for two separate reasons. They used to be one, and that is
    // why every step of every run paid for both.
    //
    // OCR is a privacy control: it is the only thing in the system that can read text
    // painted as pixels, and that frame is transmitted. So it is skipped only when the
    // structure channel can prove there is nothing in the picture it did not already
    // read — no image, no canvas, no unscriptable frame, no CSS background, and no
    // truncated walk. Otherwise it runs, over exactly those surfaces.
    //
    // The detector is an accuracy aid: it finds *controls* the DOM did not describe and
    // reads no text at all, so skipping it can never leak anything. It is skipped when
    // the DOM walk already produced a well-labelled page, where a forward pass costs
    // seconds and finds nothing new.
    const surfaces = rasterSurfaces(graph);
    const truncated = graph.nodes.length >= ELEMENT_GRAPH_NODE_CAP;
    const needsOcr = surfaces.length > 0 || truncated;
    const needsDetector = detectorWouldHelp(graph, surfaces);

    if (!needsOcr && !needsDetector) {
      return {
        graph,
        frame,
        words: [],
        url: graph.url,
        ...(captureNote === undefined ? {} : { captureNote }),
      };
    }

    // A screenshot may leave the browser only after local visual screening has read
    // it. The bundled ViT loads automatically rather than silently sending an image
    // that only the DOM channel ever inspected.
    try {
      if (needsDetector && !isDetectorLoaded()) {
        await loadDetector({ capabilities: platform.capabilities, spec: OWLVIT_BASE32 });
      }
      const pixels = await observePixels({
        dataUrl: frame.dataUrl,
        devicePixelRatio: frame.scale,
        capabilities: platform.capabilities,
        runOcr: needsOcr,
        runDetector: needsDetector,
        // A truncated walk means the missing text could be anywhere, so the whole frame
        // is read. Otherwise only the painted surfaces are.
        ...(truncated ? {} : { ocrRegions: surfaces }),
      });
      words = pixels.words;
      graph = fuseChannels({
        structure: graph,
        regions: pixels.regions,
        words: pixels.words,
      }).graph;
    } catch (error) {
      // No fallback. The screenshot is the agent's primary evidence and the local
      // vision pass is what makes sending it safe, so a failure here is a real
      // failure with a real message — not a quiet downgrade to page text that leaves
      // the user wondering why the agent went blind.
      return { url, words: [], visionError: describe(error) };
    }
  }

  return {
    graph,
    ...(frame === undefined ? {} : { frame }),
    words,
    url: graph.url,
    ...(captureNote === undefined ? {} : { captureNote }),
  };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const { task, tabId, platform, settings, callbacks, signal } = options;
  const { onSay, onPhase, onAudit } = callbacks;

  const supplied = new SuppliedValues();
  await supplied.restore();

  // The raw request is local-only. Extract any labelled values into browser-session
  // storage and give the reasoning service opaque handles instead.
  const initialKnown = vault.asRedactionDictionary();
  const taskRedaction = sanitizeOutboundText(task, initialKnown, (match) => {
    if (match.source === 'known_value') return `<HIDDEN_${match.piiType.toUpperCase()}>`;
    return supplied.supply('TASK_LOCAL_VALUE', match.value, { piiType: match.piiType });
  });
  const safeTask = taskRedaction.text;
  const removedFromTask: readonly SensitiveTextMatch[] = taskRedaction.matches;

  const steps: StepRecord[] = [];
  const history: string[] = [];
  const actionTimes: number[] = [];
  /** How many times each (action, observation) pair has come round. */
  const seen = new Map<string, number>();
  /**
   * How many times each action has been proposed, whatever the screen looked like.
   *
   * Cleared on real navigation, so this counts attempts on one page rather than over the
   * whole run. Without it, a page that jitters between turns hands `seen` a fresh bucket
   * every time and the same click repeats forever.
   */
  const attempts = new Map<string, number>();
  let badReplies = 0;
  let bytesSent = 0;
  let step = 0;
  let interpretedGoal: string | undefined;
  let retainedPlan: string[] = [];
  let recoveryHint: string | undefined;
  let previousFingerprint: string | undefined;
  /** Origin and path last seen, for deciding whether we genuinely went somewhere. */
  let previousPlace: string | undefined;
  let previousOrigin: string | undefined;
  /** What the previous step set out to change, checked against this read. */
  let expectation: Expectation | undefined;
  /**
   * The route this run is taking, kept for next time.
   *
   * Only the steps that landed, and only their labels and roles. Saved at the end, and
   * only when the run reports success, so a failed exploration is not stored as advice.
   */
  const trail: RouteStep[] = [];
  /** Origin the remembered route was looked up for, so it is fetched once per site. */
  let recalledFor: string | undefined;
  let recalledRoute: Route | undefined;
  /** Values already asked about this run, so the same question is never repeated. */
  const asked = new Set<string>();
  const downloadRequested = /\b(?:download|save)\b/i.test(task);
  const downloadTracker = downloadRequested ? DownloadTracker.create() : undefined;
  let downloadCompleted = false;

  const apiKey = await readApiKey();

  const finish = (
    phase: LoopPhase,
    reason: string,
    extra: { answer?: string; alreadyLogged?: boolean } = {},
  ): LoopResult => {
    downloadTracker?.dispose();
    onPhase(phase, reason);
    return {
      finished: phase === 'done',
      ...(extra.answer === undefined ? {} : { answer: extra.answer }),
      steps,
      reason,
      bytesSent,
      reasonAlreadyLogged: extra.alreadyLogged ?? false,
    };
  };

  /**
   * Report a failure exactly once, so the caller does not print it again.
   *
   * `message` is one short sentence for the chat. Anything diagnostic goes to the
   * console instead — the chat used to show two-sentence explanations written for a
   * developer, complete with the phrase "this is a bug in the redaction pipeline", which
   * is not something to put in front of the person using the thing.
   */
  const failWith = (message: string, detail?: unknown): LoopResult => {
    if (detail !== undefined) console.error('[yukti]', message, detail);
    onSay(message, 'bad');
    return finish('failed', message, { alreadyLogged: true });
  };

  const stopped = (): LoopResult => finish('stopped', 'Stopped there.');

  // ---- Understand the request, once -----------------------------------
  // Before any page is read, so nothing on a page can influence how the request is
  // interpreted, and so every later turn plans against one fixed goal instead of
  // re-reading a misspelled sentence and drifting away from it.
  onPhase('thinking', 'Working out what you want');
  const plan = await planTask({
    task: safeTask,
    settings,
    ...(apiKey === undefined ? {} : { apiKey }),
    signal,
  });
  if (signal.aborted) return stopped();

  if (plan === undefined) {
    interpretedGoal = safeTask;
  } else {
    interpretedGoal = plan.goal;
    // A step carrying a template phrase — "search for your college website" — is worse
    // than no step: the action model copies it verbatim into a real search box. Drop
    // those and keep the goal, which holds the user's own words.
    retainedPlan = plan.steps.filter((item) => !isFillerText(item));
    if (plan.site !== undefined) {
      history.push(
        `plan: the user named "${plan.site}" — find it by searching and opening the official ` +
          'result, never by guessing a hostname',
      );
    }
    if (plan.answersFromScreen) {
      history.push(
        'plan: this is a question about the current screen; answer it without navigating',
      );
    }
  }

  // ---- Bring the on-device vision model up before the first screenshot --
  // Required, not optional: every frame is screened by it before anything leaves, and
  // the agent reads the screen through it. Loaded once here so the one-off wait happens
  // in a named phase rather than looking like a stall mid-task.
  if (settings.sendScreenshot && !isDetectorLoaded()) {
    onPhase('looking', 'Preparing on-device vision');
    try {
      await loadDetector({ capabilities: platform.capabilities, spec: OWLVIT_BASE32 });
    } catch (error) {
      return failWith(VISION_FAILED, error);
    }
    if (signal.aborted) return stopped();
  }

  while (!signal.aborted) {
    step++;

    // ---- Look ------------------------------------------------------------
    onPhase('looking', 'Reading the page');
    const page = await readPage(tabId, platform);
    if (signal.aborted) return stopped();

    const { graph, frame, words, captureNote } = page;
    const fingerprint = observationFingerprint(graph, page.url);
    // Advice about a failed attempt used to be wiped whenever the page changed in any
    // way, which on a live page is every turn — so the model was never actually told it
    // had already tried something. It is cleared when we genuinely move somewhere else,
    // or after something works, and not otherwise.
    if (previousFingerprint !== undefined && safeOrigin(page.url) !== previousOrigin) {
      recoveryHint = undefined;
    }

    // Real navigation clears the total-attempt counters, so the second-tier limit means
    // "six attempts on this page" rather than six across the whole run. Clicking "Next"
    // through twenty pages of results has to stay possible; standing still does not.
    const movedSomewhereNew =
      previousFingerprint !== undefined &&
      `${safeOrigin(page.url)}|${pathOf(page.url)}` !== previousPlace;
    if (movedSomewhereNew) attempts.clear();

    previousFingerprint = fingerprint;
    previousOrigin = safeOrigin(page.url);
    previousPlace = `${safeOrigin(page.url)}|${pathOf(page.url)}`;

    // Local visual screening is not optional, so its failure ends the run with the
    // real reason instead of silently continuing half-blind.
    if (page.visionError !== undefined) {
      return failWith(VISION_FAILED, page.visionError);
    }

    if (captureNote !== undefined) {
      console.warn('[yukti] capture unavailable', captureNote);
      history.push(`step ${String(step)}: no screenshot this turn; use the page structure`);
    }

    // ---- Hide, locally, before anything is sent -------------------------
    let packet: EgressPacket | undefined;
    let packetJson = '';
    /** Full resolution, masked. Stays on this machine, for the Audit tab. */
    let redactedScreenshot: string | undefined;
    /** The same masked frame, resampled down. This is the one that is sent. */
    let wireScreenshot: string | undefined;
    let annotatedScreenshot: string | undefined;
    let hidden: readonly HiddenItem[] = [];
    let withheld: readonly WithheldField[] = [];
    let withheldScreenshot = false;
    const dictionary = [...vault.asRedactionDictionary(), ...supplied.asRedactionDictionary()];

    // ---- Have we done this here before? ----------------------------------
    // Looked up once per origin rather than once per turn: the answer cannot change
    // mid-site, and this reads from extension storage.
    const currentOrigin = originOf(page.url);
    if (recalledFor !== currentOrigin) {
      recalledFor = currentOrigin;
      recalledRoute = await recallRoute(currentOrigin, interpretedGoal ?? safeTask);
      if (recalledRoute !== undefined) {
        history.push(
          `note: this site has been used for something like this before; a remembered route is ` +
            'offered below as advice, not as a script',
        );
      }
    }

    // ---- Did the last step actually achieve anything? --------------------
    // Placed after the vision gate and before anything is sent, so the finding travels
    // with this turn's prompt rather than a turn late. It overwrites `recoveryHint`
    // deliberately: evidence from the page about what just happened is worth more than a
    // generic "that was refused, try something else".
    if (expectation !== undefined) {
      const outcome = checkOutcome(
        expectation,
        graph,
        page.url,
        (text) => sanitizeOutboundText(text, dictionary).text,
      );
      if (outcome !== undefined) {
        recoveryHint = outcome.hint;
        history.push(`step ${String(step - 1)}: ${outcome.note}`);
      }
      expectation = undefined;
    }

    if (graph !== undefined) {
      onPhase('hiding', 'Hiding your data');

      const detection = detectPii({ graph, words, vault: dictionary });

      const bounds =
        frame === undefined
          ? { x: 0, y: 0, width: graph.viewport.width, height: graph.viewport.height }
          : {
              x: 0,
              y: 0,
              width: frame.width / frame.scale,
              height: frame.height / frame.scale,
            };

      const redaction = planRedaction({
        findings: detection.findings,
        viewport: graph.viewport,
        bounds,
      });
      withheldScreenshot = redaction.verdict === 'refuse';

      // Both images are built on every turn a frame exists, including turns where the
      // packet will withhold the picture. Withholding is about what leaves the machine;
      // the Audit tab is about what the user can inspect, and it needs the marked frame
      // for every step or the record has holes in exactly the interesting places.
      if (frame !== undefined) {
        try {
          // Both images from one pass over the frame. The annotated one keeps the
          // original pixels and is shown only in the Audit tab — it exists so the
          // boxes can be checked against the text they are meant to cover, which is
          // the only way the claim is verifiable rather than asserted. It is never
          // packaged.
          const [redacted, annotated] = await Promise.all([
            redactImage({
              dataUrl: frame.dataUrl,
              paints: redaction.paints,
              scale: frame.scale,
              // Ask for a transmission copy as well. The full-size one stays local for
              // the Audit tab; only this one goes out, and on a HiDPI screen that is a
              // quarter of the bytes for text no smaller than the user is reading.
              wireMaxEdge: WIRE_MAX_EDGE,
            }),
            annotateRegions(frame.dataUrl, redaction.paints, frame.scale),
          ]);

          // Check the masks geometrically rather than by running OCR over the new
          // image. A second recognition pass doubled the per-turn cost for an answer
          // the rectangles already contain: every finding that policy says to cover,
          // and every recognised word matching a local value, must sit inside a paint.
          const uncovered = uncoveredSensitiveRegions(
            detection.findings,
            words,
            redaction.paints,
            dictionary,
            graph.viewport,
          );
          if (uncovered > 0) {
            throw new Error(`${String(uncovered)} sensitive region(s) were not covered`);
          }

          redactedScreenshot = redacted.dataUrl;
          // Falls back to the full-size copy when the frame was already small enough,
          // so this is never an unnecessary second encode.
          wireScreenshot = redacted.wireDataUrl ?? redacted.dataUrl;
          annotatedScreenshot = annotated;
        } catch (error) {
          // Fail closed. Sending an unredacted frame because redaction broke would
          // invert the entire guarantee, so the image is dropped instead.
          console.warn('[yukti] screenshot withheld after redaction failure', error);
          history.push(
            `step ${String(step)}: screenshot withheld — local redaction verification failed`,
          );
        }
      }

      try {
        const pageOrigin = originOf(graph.url);
        const availableTokens = [
          ...vault
            .list()
            // The provider API key lives in the same vault because that is the only
            // encrypted store on the device, but it is not the user's data to type into a
            // page. Offering it as a fillable value is how `API_KEY_PROVIDER_KEY` ended
            // up being typed into a form.
            .filter((entry) => entry.slot !== KEY_SLOT)
            .filter((entry) => entry.site === undefined || entry.site === pageOrigin)
            .map((entry) => slotToken(entry.piiType, entry.slot)),
          ...supplied.ids(pageOrigin),
        ];
        const built = buildEgressPacket({
          graph,
          findings: detection.findings,
          plan: redaction,
          // The transmission copy, so the packet and the audit's byte count describe the
          // same image the provider actually received.
          ...(wireScreenshot === undefined ? {} : { redactedScreenshot: wireScreenshot }),
          vault: dictionary,
          availableTokens,
          includeScreenshot: wireScreenshot !== undefined,
          // The picture is what the agent must have; the redacted page text is extra
          // context that measurably improves how well the model reads a form, and it has
          // been through the detector, the value sweep and the canary before it gets
          // here. Both go.
          includeText: true,
        });
        packet = built.packet;
        packetJson = built.json;

        // Somewhere the redactor could not clean, so the field was emptied rather than
        // transmitted. One quiet line, because it is a normal safety outcome rather
        // than a failure — the task continues without it.
        if (built.withheld.length > 0) {
          withheld = built.withheld;
          console.warn('[yukti] withheld fields', built.withheld);
        }
      } catch (error) {
        return failWith('I could not get this page ready to send safely, so I stopped.', error);
      }

      hidden = describeFindings(detection.findings);

      if (withheldScreenshot) {
        history.push(
          `step ${String(step)}: screenshot withheld because local redaction coverage was too high`,
        );
      }
    }

    if (signal.aborted) return stopped();

    // ---- Ask the model ---------------------------------------------------
    onPhase('thinking', `Asking ${settings.model}`);

    const safeHistoryResults = history.map((line) => sanitizeOutboundText(line, dictionary));
    const safeUnreadable =
      page.unreadable === undefined
        ? undefined
        : sanitizeOutboundText(page.unreadable, dictionary);
    const messages = buildMessages({
      task: safeTask,
      history: safeHistoryResults.map((result) => result.text),
      taskState: {
        ...(interpretedGoal === undefined ? {} : { interpretedGoal }),
        ...(retainedPlan.length === 0 ? {} : { plan: retainedPlan }),
        ...(recoveryHint === undefined ? {} : { recovery: recoveryHint }),
      },
      ...(packet === undefined ? {} : { packet }),
      ...(safeUnreadable === undefined ? {} : { unreadable: safeUnreadable.text }),
      // Already sanitized when it was stored, and swept again on the way out, because a
      // route written by an older build predates that guarantee.
      ...(recalledRoute === undefined
        ? {}
        : {
            route: describeRoute(recalledRoute).map(
              (line) => sanitizeOutboundText(line, dictionary).text,
            ),
          }),
      currentUrl: safeOrigin(page.url),
      // Always, whenever a masked frame exists. The picture is the agent's primary
      // evidence: it is what lets the model answer "what is on this screen" and pick the
      // right control. Heavy redaction is a reason to cover more of the image, never a
      // reason to fall back to structure alone.
      //
      // The resampled copy, not the full-size one. The Audit tab keeps the original.
      ...(wireScreenshot === undefined ? {} : { screenshot: wireScreenshot }),
    });

    // Last gate before the provider client. Exclude image bytes from this textual
    // check—the image was independently OCR-verified above—and scan every other
    // serialized field, including task, history, prompt, and packet.
    const textOnlyMessages = messages.map((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.filter((part) => part.type === 'text')
        : message.content,
    }));
    const removedText = [
      ...removedFromTask,
      ...safeHistoryResults.flatMap((result) => result.matches),
      ...(safeUnreadable?.matches ?? []),
    ];
    if (!outboundTextIsSafe(JSON.stringify(textOnlyMessages), dictionary, removedText)) {
      return failWith('I could not cover everything of yours on this page, so I sent nothing.');
    }

    // Measured off the serialised request rather than the packet, so the number the
    // user is shown is what actually went on the wire — prompt, page text, image and
    // all — not a proxy for it.
    const wireBytes = new TextEncoder().encode(JSON.stringify(messages)).length;

    // Recorded before the call, so a request that fails or is cancelled still
    // appears in the audit trail. A gap there would be indistinguishable from
    // something being hidden.
    onAudit({
      step,
      ...(annotatedScreenshot === undefined ? {} : { annotatedScreenshot }),
      ...(redactedScreenshot === undefined ? {} : { redactedScreenshot }),
      packetJson,
      bytes: wireBytes,
      hidden,
      withheld,
      withheldScreenshot,
      url: page.url,
    });

    let reply: string;
    try {
      const result = await chat({
        settings,
        ...(apiKey === undefined ? {} : { apiKey }),
        messages: messages as readonly ChatMessage[],
        signal,
      });
      reply = result.text;
      bytesSent += wireBytes;
    } catch (error) {
      if (signal.aborted) return stopped();
      return failWith(
        error instanceof ProviderError
          ? error.message
          : 'The model did not answer, so I stopped.',
      );
    }

    // ---- Understand it ---------------------------------------------------
    const parsed = parseAction(reply);
    if (!parsed.ok) {
      // Feed the complaint back rather than giving up: a malformed reply is usually
      // corrected next turn once the model is told what was wrong.
      history.push(`step ${String(step)}: reply was not usable — ${parsed.error}`);
      badReplies++;
      if (badReplies > REPEAT_LIMIT) {
        return failWith(
          `I could not understand ${settings.model}'s replies. Try another model in ⋯.`,
        );
      }
      continue;
    }

    badReplies = 0;
    if (parsed.goal !== undefined) {
      interpretedGoal = sanitizeOutboundText(parsed.goal, dictionary).text.slice(0, 300);
    } else if (interpretedGoal === undefined) {
      interpretedGoal = safeTask;
    }
    if (parsed.plan !== undefined) {
      retainedPlan = parsed.plan
        .map((item) => sanitizeOutboundText(item, dictionary).text.slice(0, 180))
        .filter((item) => item !== '')
        .slice(0, 8);
    }

    const action = parsed.action;

    // ---- Are we going in circles? ---------------------------------------
    //
    // Two tiers, because one is evadable without anybody intending it.
    //
    // Tier one keys on (action, screen) and catches the ordinary case quickly. Tier two
    // keys on the action alone, and exists because a page that keeps shifting underneath
    // — a late advert, a suggestion list — gives tier one a fresh bucket every turn, so
    // the same click could repeat indefinitely with a count of one. That is exactly what
    // a live run did.
    const signature = signatureOf(action);
    const key = `${signature}@${fingerprint}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);

    const totalCount = (attempts.get(signature) ?? 0) + 1;
    attempts.set(signature, totalCount);

    if (count > REPEAT_LIMIT || totalCount > REPEAT_LIMIT_TOTAL) {
      return finish(
        'stopped',
        'I kept trying the same thing on this page and it was not getting anywhere, so I stopped. Have a look and tell me how you would like me to continue.',
      );
    }
    if (count === 1 && totalCount === 1) recoveryHint = undefined;

    if (count >= 2 || totalCount >= 3) {
      // Say which tier noticed, because the two mean different things to the model: "this
      // failed here before" versus "you have now tried this a lot, on a page that keeps
      // moving". The second is the one that should make it change approach entirely
      // rather than look for a slightly different element.
      const tried = Math.max(count, totalCount) - 1;
      recoveryHint =
        `The proposed ${action.type.replace(/_/g, ' ')} has already been attempted ` +
        `${String(tried)} time${tried === 1 ? '' : 's'} without progress` +
        `${totalCount > count ? ' on a page that keeps changing underneath it' : ' on this exact local page state'}. ` +
        'Do not repeat it. Inspect the visual and structural context and choose a different route.';
      history.push(
        `step ${String(step)}: local controller rejected a repeated no-progress proposal`,
      );
      if (count === REPEAT_LIMIT || totalCount === REPEAT_LIMIT_TOTAL) continue;
    }

    // ---- Do it -----------------------------------------------------------
    if (action.type === 'stop') {
      if (action.success !== false && downloadRequested && !downloadCompleted) {
        recoveryHint =
          'The task requires a download, but the local browser has not confirmed a completed file. Find and activate the real download control.';
        history.push(
          `step ${String(step)}: completion rejected locally because no download finished`,
        );
        continue;
      }
      // An empty answer parses, because refusing a `stop` that is genuinely complete would
      // cost a round trip to be told the same thing again. But it cannot be shown: the run
      // would simply end with a blank line in the chat, which reads as a crash.
      const stated = sanitizeOutboundText(action.answer, dictionary).text.trim();
      const answer =
        stated !== ''
          ? stated
          : action.success === false
            ? 'I could not finish that.'
            : 'That is done.';

      // Leave the route behind for next time, but only for a run that actually got
      // somewhere. A one-step answer about what is on screen is not a route, and a
      // failed run's route is a map to a dead end.
      if (action.success !== false && trail.length >= 2) {
        await rememberRoute({
          origin: originOf(page.url),
          goal: sanitizeOutboundText(interpretedGoal ?? safeTask, dictionary).text,
          steps: trail,
        });
      }

      onSay(answer, action.success === false ? 'warn' : 'step');
      return finish(action.success === false ? 'failed' : 'done', 'Finished.', {
        answer,
        alreadyLogged: true,
      });
    }

    if (action.type === 'request_user_input') {
      const requestedType = action.piiType ?? piiTypeFromToken(action.placeholderId);
      const sessionToken =
        requestedType === undefined
          ? undefined
          : supplied.tokenForType(requestedType, originOf(page.url));
      const matchingVault =
        requestedType === undefined
          ? []
          : vault
              .list()
              .filter((entry) => entry.slot !== KEY_SLOT)
              .filter(
                (entry) =>
                  entry.piiType === requestedType &&
                  (entry.site === undefined || entry.site === originOf(page.url)),
              );
      // First match, not "exactly one". Requiring a single match meant that saving two
      // registration numbers turned into a prompt for a third.
      const vaultToken =
        matchingVault[0] === undefined
          ? undefined
          : slotToken(matchingVault[0].piiType, matchingVault[0].slot);
      const existingToken = sessionToken ?? vaultToken;
      if (existingToken !== undefined) {
        recoveryHint = `Use ${existingToken}; it is already saved on this machine.`;
        history.push(
          `step ${String(step)}: the requested local value is already available as ${existingToken}`,
        );
        continue;
      }

      const askKey = requestedType ?? action.placeholderId.toUpperCase();
      if (asked.has(askKey)) {
        recoveryHint =
          'The user has already been asked for that once and it is not available. Continue without it or finish and say what is missing.';
        history.push(`step ${String(step)}: already asked for this value once`);
        continue;
      }
      asked.add(askKey);

      onPhase('asking', 'Waiting for you');
      const value = await callbacks.requestInput(
        action.category,
        action.reason,
        action.placeholderId,
      );
      if (value === undefined || value === '') {
        return finish(
          'stopped',
          'No problem, I have stopped there. I needed that to carry on.',
        );
      }
      const token = supplied.supply(action.placeholderId, value, {
        ...(requestedType === undefined ? {} : { piiType: requestedType }),
        origin: originOf(page.url),
      });

      history.push(
        `step ${String(step)}: the user supplied a local-only value as ${token} ` +
          `(${String(value.length)} characters) — use that token without asking again`,
      );
      continue;
    }

    onPhase('acting', action.type);

    // Navigation belongs to the loop: it owns the tab, so it is the only thing that
    // can wait for the load properly. Getting this wrong was why the agent used to
    // read the page it had just left.
    if (
      action.type === 'goto_url' ||
      action.type === 'go_back' ||
      action.type === 'go_forward'
    ) {
      if (action.type === 'goto_url' && !isReadableUrl(action.url)) {
        recoveryHint =
          'Only normal HTTPS or HTTP navigation is allowed. Choose a safe web address.';
        history.push(
          `step ${String(step)}: local controller refused a non-web navigation target`,
        );
        continue;
      }

      // An address composed out of the words in the request is how the agent ended up on
      // a site that does not exist. Refused before the tab moves, with the alternative
      // named so the next turn does the useful thing instead.
      if (action.type === 'goto_url' && looksInvented(action.url)) {
        recoveryHint =
          "That address describes a site rather than naming one, so it does not exist. Open a search engine, search for the site in the user's own words, and click the official result.";
        history.push(
          `step ${String(step)}: refused a made-up address; search for the site instead`,
        );
        continue;
      }
      try {
        const result =
          action.type === 'goto_url'
            ? await navigateAndWait(tabId, action.url)
            : await historyAndWait(tabId, action.type === 'go_back' ? 'back' : 'forward');

        history.push(
          `step ${String(step)}: opened ${result.url}` +
            (result.readable ? '' : ' (loaded, but its contents cannot be read)'),
        );
        if (!result.readable) {
          history.push(
            `step ${String(step)}: destination loaded but cannot be inspected locally`,
          );
        }
      } catch (error) {
        console.warn('[yukti] navigation failed', error);
        history.push(`step ${String(step)}: navigation failed; choose another route`);
        recoveryHint =
          'The previous navigation failed. Use a verified official result or another safe route.';
      }
      continue;
    }

    // ---- Check it locally, then carry it out ----------------------------
    if (graph === undefined) {
      // The model asked to touch a page that is not there. Say so precisely, which
      // is what lets it correct itself rather than trying again.
      const message = `There is no page to ${action.type.replace(/_/g, ' ')} on yet.`;
      history.push(
        `step ${String(step)}: ${message} Open a site first with goto_url — no element ` +
          `ids exist until then.`,
      );
      continue;
    }

    // Typing a description of a value ("your college name") is never what the user
    // wanted, and it is worse than doing nothing: it fills a real form with nonsense.
    const literalText =
      action.type === 'type' && action.value.kind === 'literal'
        ? action.value.text
        : action.type === 'select' && action.option.kind === 'literal'
          ? action.option.text
          : undefined;
    if (literalText !== undefined && isFillerText(literalText)) {
      recoveryHint =
        `"${literalText}" is a description or a handle, not text to type. Use the user's own ` +
        `words from their request verbatim; to use a stored value send ` +
        `{"kind":"placeholder","placeholderId":"<HANDLE>"} instead of typing the handle.`;
      history.push(`step ${String(step)}: refused "${literalText}" — not real text to type`);
      continue;
    }

    // Said here rather than before the guards above, so the transcript cannot claim the
    // agent typed something it actually refused to type.
    onSay(narrate(action, graph), 'step');

    const context: ValidatorContext = {
      graph,
      origin: originOf(graph.url),
      vault: vault.list(),
      suppliedPlaceholders: supplied.ids(originOf(graph.url)),
      suppliedTypes: supplied.types(originOf(graph.url)),
      recentActionTimes: actionTimes,
    };

    const record = await executeAction({
      tabId,
      action,
      index: step,
      dispatch: platform.dispatch,
      context,
      supplied,
      requestInput: callbacks.requestInput,
      requestPassphrase: callbacks.requestPassphrase,
    });

    // ---- Missing local data is a controller concern -----------------------
    //
    // Two refusals mean the same thing in practice: the field wants something personal and
    // we do not have it. One is the model naming a handle that does not exist; the other is
    // the model composing a value it had no business composing.
    //
    // Both used to end in a recovery hint and another round trip, which is how a live run
    // produced three turns of "Typing John into First Name — that box is not asking for
    // what I was about to type". The model has no way to fix either from advice: it cannot
    // conjure a value it does not have. So the controller asks the user directly and the
    // task carries on. One question instead of three wasted turns and a scary message.
    const missingLocally =
      !record.ok &&
      (record.refusedAs === 'unresolvable_placeholder' ||
        record.refusedAs === 'secret_target_mismatch');

    if (missingLocally) {
      const targetId = 'target' in action ? action.target : undefined;
      const placeholderId =
        action.type === 'type' && action.value.kind === 'placeholder'
          ? action.value.placeholderId
          : action.type === 'select' && action.option.kind === 'placeholder'
            ? action.option.placeholderId
            : // An invented literal names nothing, so a token is derived from the field's
              // own type below and this stands in until then.
              (targetId ?? 'MISSING');
      {
        // From the field, not from the token. The token is frequently something the model
        // made up, and `FIRST_NAME_LOCAL_A` carries no usable type at all.
        const piiType = wantedType(graph, targetId, placeholderId);

        // Saved values come first, always. Only ask when there is genuinely nothing on
        // this machine to use — and never ask twice for the same thing in one run.
        const savedHere =
          piiType === undefined
            ? []
            : vault
                .list()
                .filter((entry) => entry.slot !== KEY_SLOT)
                .filter((entry) => entry.piiType === piiType)
                .filter(
                  (entry) => entry.site === undefined || entry.site === originOf(graph.url),
                );
        const savedToken =
          savedHere[0] === undefined
            ? undefined
            : slotToken(savedHere[0].piiType, savedHere[0].slot);

        if (savedToken !== undefined) {
          recoveryHint = `Use the saved value ${savedToken} for that field.`;
          history.push(`step ${String(step)}: a saved value is available as ${savedToken}`);
          continue;
        }

        const askKey = piiType ?? placeholderId.toUpperCase();
        if (asked.has(askKey)) {
          recoveryHint =
            'That value is not on this machine and the user has already been asked once. Continue without it or finish and explain what is missing.';
          history.push(`step ${String(step)}: already asked for this value once`);
          continue;
        }
        asked.add(askKey);

        const category =
          piiType === 'otp'
            ? 'otp'
            : piiType === 'password'
              ? 'password'
              : 'missing_profile_field';

        // A token the executor can actually resolve later. When the model invented one, or
        // named the element instead, it is replaced with a type-derived token — otherwise
        // the value would be stored under a name nothing looks up.
        const fieldName = plainFieldName(graph, targetId);
        const usableToken =
          piiTypeFromToken(placeholderId) !== undefined
            ? placeholderId
            : piiType === undefined
              ? placeholderId
              : slotToken(piiType, 'asked');

        onPhase('asking', 'Waiting for you');
        const value = await callbacks.requestInput(
          category,
          fieldName === undefined
            ? 'This is needed to carry on, and it stays on your machine.'
            : `This goes into “${fieldName}” on ${siteName(graph.url)}, and stays on your machine.`,
          usableToken,
          {
            ...(piiType === undefined ? {} : { piiType }),
            ...(fieldName === undefined ? {} : { fieldName }),
            site: siteName(graph.url),
          },
        );
        if (value === undefined || value === '') {
          return finish(
            'stopped',
            'No problem, I have stopped there. I needed that to carry on.',
          );
        }
        const token = supplied.supply(usableToken, value, {
          ...(piiType === undefined ? {} : { piiType }),
          origin: originOf(graph.url),
        });
        history.push(
          `step ${String(step)}: ${token} is now available locally; use it without asking again`,
        );
        continue;
      }
    }

    steps.push(record);
    actionTimes.push(Date.now());

    if (record.ok) {
      const remembered = routeStepFor(
        action,
        graph,
        (text) => sanitizeOutboundText(text, dictionary).text,
      );
      if (remembered !== undefined) trail.push(remembered);
    }

    history.push(
      `step ${String(step)}: ${record.action}${record.target === undefined ? '' : ` ${record.target}`} — ` +
        `${record.ok ? 'done' : 'refused'}: ${record.detail}`,
    );

    if (!record.ok) {
      console.warn('[yukti] local action refused', record);
      const line = refusalLine(record);
      if (line !== undefined) onSay(line, 'warn');
      // Tell the model *why*, in its own terms. Without this the refusal existed only in
      // the console and the model had no reason to choose differently, so it proposed the
      // same thing until the run gave up.
      recoveryHint =
        `The last attempt was refused here: ${sanitizeOutboundText(record.detail, dictionary).text}. ` +
        'Pick a different element or a different approach; repeating it will be refused again.';
    }

    // Wait for whatever the action set off. A click can navigate, and if it did
    // this waits for the destination properly instead of guessing at a delay.
    await settleAfterAction(tabId, page.url, settleBudgetFor(action));

    if (
      record.ok &&
      downloadRequested &&
      !downloadCompleted &&
      downloadTracker !== undefined &&
      mayStartRequestedDownload(action, graph)
    ) {
      const outcome = await downloadTracker.waitForActivity();
      if (outcome === 'complete') {
        downloadCompleted = true;
        recoveryHint = undefined;
        history.push(`step ${String(step)}: the requested file download completed locally`);
        onSay('The file has downloaded.', 'step');
      } else if (outcome === 'failed') {
        recoveryHint =
          'The browser did not complete that download. Try the portal download control again or choose its PDF option.';
        history.push(`step ${String(step)}: local download failed or timed out`);
      }
    }

    // ---- The rest of the batch -------------------------------------------
    //
    // One action per round trip meant a fifteen-field form cost fifteen screenshots,
    // fifteen redaction passes and fifteen model calls — most of the wall-clock time, and
    // a reliability problem too, because every turn re-derived the plan and could change
    // its mind halfway through a form.
    //
    // Only the tail runs here. The primary action keeps the full single-action path above,
    // with its download tracking and its ask-the-user recovery, because that logic is
    // worth more than the one round trip it would save to fold it in.
    //
    // `batchContinuesAfter` is what makes this safe: the batch stops the moment an action
    // could invalidate the element graph the whole batch was validated against. So a
    // click, a submit, or a navigation ends it, and the next turn re-reads the page.
    if (record.ok && parsed.actions.length > 1 && batchContinuesAfter(action)) {
      for (const queued of parsed.actions.slice(1)) {
        if (signal.aborted) return stopped();

        const verdict = validateAction(queued, {
          ...context,
          recentActionTimes: actionTimes,
        });
        if (!verdict.ok) {
          // Not a failure of the turn. The model proposed more than the page turned out
          // to support, so the rest is dropped and the next turn sees the real state.
          console.warn('[yukti] dropped the rest of the batch', verdict);
          recoveryHint =
            `Only part of your proposed sequence ran. The remainder was refused locally: ` +
            `${sanitizeOutboundText(verdict.detail, dictionary).text}. Re-read the page before continuing.`;
          history.push(`step ${String(step)}: rest of the batch dropped — ${verdict.code}`);
          break;
        }

        onSay(narrate(queued, graph), 'step');

        const queuedRecord = await executeAction({
          tabId,
          action: queued,
          index: step,
          dispatch: platform.dispatch,
          context,
          supplied,
          requestInput: callbacks.requestInput,
          requestPassphrase: callbacks.requestPassphrase,
        });

        steps.push(queuedRecord);
        actionTimes.push(Date.now());
        if (queuedRecord.ok) {
          const remembered = routeStepFor(
            queued,
            graph,
            (text) => sanitizeOutboundText(text, dictionary).text,
          );
          if (remembered !== undefined) trail.push(remembered);
        }
        history.push(
          `step ${String(step)}: ${queuedRecord.action}` +
            `${queuedRecord.target === undefined ? '' : ` ${queuedRecord.target}`} — ` +
            `${queuedRecord.ok ? 'done' : 'refused'}: ${queuedRecord.detail}`,
        );

        if (!queuedRecord.ok) {
          console.warn('[yukti] batched action refused', queuedRecord);
          const line = refusalLine(queuedRecord);
          if (line !== undefined) onSay(line, 'warn');
          recoveryHint =
            `Part of your sequence was refused here: ` +
            `${sanitizeOutboundText(queuedRecord.detail, dictionary).text}. ` +
            'Re-read the page and choose a different approach for the remainder.';
          break;
        }

        // A short settle between fields, then stop if this one could have changed the
        // page underneath the remaining actions.
        await settleAfterAction(tabId, page.url, settleBudgetFor(queued));
        if (!batchContinuesAfter(queued)) break;
      }
    }

    // ---- Record what this step was supposed to do ------------------------
    // Written last so it only exists when something really ran; every earlier `continue`
    // in this body is a turn that acted on nothing and has nothing to verify.
    //
    // The *last* executed action is the one to check, because it is the one that ended
    // the batch — a run of `type`s followed by a submit is answered by what the submit
    // did, not by what the first field did.
    const executed = steps.filter((record) => record.index === step && record.ok);
    const lastExecuted = executed[executed.length - 1];
    if (lastExecuted !== undefined) {
      // Searched from the end, because a batch can hold several actions of one type and it
      // is the last one that decides what to check. `type, type, type(submit)` is answered
      // by what the submit did; matching the first `type` would find one with no `submit`
      // on it and conclude nothing was supposed to change.
      const acted =
        [...parsed.actions]
          .reverse()
          .find((candidate) => candidate.type === lastExecuted.action) ?? action;
      expectation = {
        action: acted,
        place: `${safeOrigin(page.url)}|${pathOf(page.url)}`,
        shape: pageShape(graph),
        typedInto: executed
          .filter((record) => record.action === 'type' && record.target !== undefined)
          .map((record) => record.target as string),
        rejected: rejectedIds(graph),
        notices: noticeTexts(graph),
      };
    }
  }

  return stopped();
}

// ---------------------------------------------------------------------------
// Explaining the redaction in words
// ---------------------------------------------------------------------------

const HOW_IT_WAS_HIDDEN: Record<string, string> = {
  mask_solid: 'covered with a solid block',
  blur: 'blurred and pixelated',
  placeholder: 'replaced with a name-only label',
  synthetic: 'swapped for a same-shape fake',
  drop: 'removed from what was sent',
  none: 'left as it was',
};

const HOW_IT_WAS_FOUND: Record<string, string> = {
  known_value: 'matched a value in your vault',
  structural: 'the field itself says what it holds',
  pattern: 'format and checksum',
  semantic: 'read from the surrounding words',
  vision_face: 'face detection',
};

/**
 * Describe what was hidden, without saying what it was.
 *
 * This is the audit tab's whole content, so it is phrased for a person: what kind of
 * thing it was, how it was covered, and how it was recognised.
 *
 * Grouped by (type, mode) and counted. A marksheet with forty masked numbers used to
 * produce forty identical rows, which buried the one row that mattered; one row
 * saying "40 ×" is the same information and can actually be read.
 *
 * The mode comes off the finding rather than the paint plan, because the finding is
 * where policy already resolved it — including downgrading any blur request on text
 * to a solid mask.
 */
export function describeFindings(findings: readonly PiiFinding[]): HiddenItem[] {
  const rows = new Map<string, { item: HiddenItem; count: number }>();

  for (const finding of findings) {
    if (finding.redaction === 'none') continue;

    const key = `${finding.piiType}:${finding.redaction}`;
    const existing = rows.get(key);
    if (existing !== undefined) {
      existing.count++;
      continue;
    }

    // Strongest evidence first: if the vault recognised it, that is what to say.
    const detector =
      finding.detectors.find((d) => d === 'known_value') ?? finding.detectors[0] ?? 'unknown';

    rows.set(key, {
      count: 1,
      item: {
        what: finding.piiType.replace(/_/g, ' '),
        how: HOW_IT_WAS_HIDDEN[finding.redaction] ?? finding.redaction,
        foundBy: HOW_IT_WAS_FOUND[detector] ?? detector,
      },
    });
  }

  return [...rows.values()].map(({ item, count }) => ({
    ...item,
    ...(count > 1 ? { count } : {}),
  }));
}
