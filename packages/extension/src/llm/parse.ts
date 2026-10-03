/**
 * Parse the model's reply into an action.
 *
 * Written as a whitelist: each action type is reconstructed field by field from
 * known keys, and anything unrecognised is refused. The alternative — casting the
 * parsed JSON to `AgentAction` — would let a malformed or hostile reply carry
 * unexpected fields straight into the executor.
 *
 * Models are also sloppy in predictable ways, and tolerating those is worth more
 * than being strict for its own sake: a fenced code block, a sentence before the
 * JSON, `"action"` at the top level instead of nested. Each of those is a wasted
 * round trip if refused, and none of them is ambiguous. What is *not* tolerated is
 * anything that changes meaning.
 */

import {
  ALL_PII_TYPES,
  type AgentAction,
  type PiiType,
  type UserInputCategory,
  type ValueRef,
} from '@sih/core';

/**
 * Most actions the model may propose in one reply.
 *
 * One action per reply was costing a full round trip — screenshot, redaction, model
 * call — for every single field of a form. A fifteen-field form meant fifteen of them,
 * which is both the bulk of the wall-clock time and a reliability problem in its own
 * right, because each turn re-derives the plan from scratch and can change its mind
 * halfway through filling a form.
 *
 * Eight is enough to cover a realistic form section without letting a confused model
 * queue up a long run of work nobody will look at before it executes.
 */
const MAX_BATCH = 8;

export interface ParseSuccess {
  readonly ok: true;
  /**
   * The first proposed action.
   *
   * Retained alongside `actions` because most call sites only care about the primary
   * one, and because a single-action reply is still by far the common case.
   */
  readonly action: AgentAction;
  /** Every proposed action in order. Always holds at least `action`. */
  readonly actions: readonly AgentAction[];
  readonly reasoning?: string;
  /** Sanitized high-level interpretation retained by the local controller. */
  readonly goal?: string;
  /** Short task plan retained locally across otherwise stateless provider calls. */
  readonly plan?: readonly string[];
}

export interface ParseFailure {
  readonly ok: false;
  /** Sent back to the model so it can correct itself rather than repeat the error. */
  readonly error: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

function fail(error: string): ParseFailure {
  return { ok: false, error };
}

/**
 * Pull a JSON object out of a reply that may be wrapped in prose or a code fence.
 *
 * Brace matching rather than a regex, because a regex cannot handle the nesting in
 * `{"action":{...}}` and would truncate at the first closing brace.
 */
function extractJson(raw: string): string | undefined {
  const text = raw.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text;

  // Whichever container opens first. A bare array is accepted because a model asked for
  // several actions will sometimes reply with just the list and no wrapper object.
  const braceAt = candidate.indexOf('{');
  const bracketAt = candidate.indexOf('[');
  const start =
    braceAt < 0 ? bracketAt : bracketAt < 0 ? braceAt : Math.min(braceAt, bracketAt);
  if (start < 0) return undefined;

  // A stack rather than a depth counter, so the repair below knows *which* closers are
  // missing and in what order — `}]}`  is not the same as `}}]`.
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < candidate.length; i++) {
    const char = candidate[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']');
      continue;
    }
    if (char === '}' || char === ']') {
      if (stack[stack.length - 1] === char) stack.pop();
      // The outermost container just closed, so this is the whole value.
      if (stack.length === 0) return candidate.slice(start, i + 1);
    }
  }

  // ---- Repair an unbalanced reply --------------------------------------
  //
  // Reaching here means the container never closed. Usually that is a model that simply
  // forgot a brace: a live run produced a complete, correct action object whose outermost
  // `{` had no matching `}` — 493 characters against a 900-token limit, so nothing was
  // truncated, the model just miscounted. Every field the controller needed was present
  // and the whole turn was thrown away.
  //
  // So the missing closers are appended and the result is offered to `JSON.parse`, which
  // is the actual arbiter. An unterminated string is closed first, for the case where the
  // reply really was cut off mid-value. If the repair does not parse, nothing is returned
  // and the caller reports a bad reply exactly as before — this can rescue a reply but it
  // cannot invent one.
  const repaired =
    candidate.slice(start) + (inString ? '"' : '') + [...stack].reverse().join('');

  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => asString(item))
    .filter((item): item is string => item !== undefined)
    .slice(0, 8);
  return items.length === 0 ? undefined : items;
}

/**
 * Parse a value reference.
 *
 * A bare string is accepted as a literal, because models produce
 * `"value": "hello"` constantly. A placeholder must be explicit — silently
 * promoting a string that happens to look like a token would be a way to smuggle a
 * guessed secret past the reader's attention.
 */
function parseValueRef(value: unknown, field: string): ValueRef | ParseFailure {
  if (typeof value === 'string') return { kind: 'literal', text: value };

  if (typeof value !== 'object' || value === null) {
    return fail(`"${field}" must be a string or {kind, ...}`);
  }

  const record = value as Record<string, unknown>;
  const kind = asString(record.kind);

  if (kind === 'literal') {
    const text = record.text;
    if (typeof text !== 'string') return fail(`"${field}.text" must be a string`);
    return { kind: 'literal', text };
  }

  if (kind === 'placeholder') {
    const id = asString(record.placeholderId) ?? asString(record.placeholder_id);
    if (id === undefined) return fail(`"${field}.placeholderId" is required`);
    return { kind: 'placeholder', placeholderId: id };
  }

  // Tolerate the shorthand a model reaches for when it omits `kind`.
  const text = asString(record.text);
  if (text !== undefined) return { kind: 'literal', text };
  const id = asString(record.placeholderId);
  if (id !== undefined) return { kind: 'placeholder', placeholderId: id };

  return fail(`"${field}.kind" must be "literal" or "placeholder"`);
}

const INPUT_CATEGORIES: readonly UserInputCategory[] = [
  'otp',
  'captcha',
  'password',
  'security_answer',
  'missing_profile_field',
  'confirmation',
  'other',
];

function parseCategory(value: unknown): UserInputCategory {
  const raw = asString(value)?.toLowerCase().replace(/[\s-]/g, '_');
  const found = INPUT_CATEGORIES.find((c) => c === raw);
  return found ?? 'other';
}

function parsePiiType(value: unknown): PiiType | undefined {
  const raw = asString(value)?.toLowerCase().replace(/[\s-]/g, '_');
  return ALL_PII_TYPES.find((type) => type === raw);
}

const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;

function buildAction(record: Record<string, unknown>): AgentAction | ParseFailure {
  const type = asString(record.type)?.toLowerCase().replace(/[\s-]/g, '_');
  if (type === undefined) return fail('"action.type" is required');

  const reasoning = asString(record.reasoning);
  const base = reasoning === undefined ? {} : { reasoning };

  switch (type) {
    case 'click': {
      const target = asString(record.target) ?? asString(record.element_id);
      if (target === undefined) return fail('click needs a "target" element id');
      return { ...base, type: 'click', target };
    }

    case 'click_point': {
      const point = record.point;
      const x = asNumber((point as Record<string, unknown> | undefined)?.x ?? record.x);
      const y = asNumber((point as Record<string, unknown> | undefined)?.y ?? record.y);
      if (x === undefined || y === undefined) return fail('click_point needs numeric x and y');
      return { ...base, type: 'click_point', point: { x, y } };
    }

    case 'type':
    case 'fill':
    case 'type_text': {
      const target = asString(record.target) ?? asString(record.element_id);
      if (target === undefined) return fail('type needs a "target" element id');

      const value = parseValueRef(record.value ?? record.text, 'value');
      if ('ok' in value) return value;

      return {
        ...base,
        type: 'type',
        target,
        value,
        ...(record.submit === true ? { submit: true } : {}),
        ...(record.clear === false ? { clear: false } : {}),
      };
    }

    case 'hover': {
      const target = asString(record.target);
      if (target === undefined) return fail('hover needs a "target" element id');
      return { ...base, type: 'hover', target };
    }

    case 'select':
    case 'select_option': {
      const target = asString(record.target);
      if (target === undefined) return fail('select needs a "target" element id');

      const option = parseValueRef(record.option ?? record.value, 'option');
      if ('ok' in option) return option;

      return { ...base, type: 'select', target, option };
    }

    case 'scroll': {
      const raw = asString(record.direction)?.toLowerCase() ?? 'down';
      const direction = SCROLL_DIRECTIONS.find((d) => d === raw) ?? 'down';
      const amount = asNumber(record.amount);
      return {
        ...base,
        type: 'scroll',
        direction,
        ...(amount === undefined ? {} : { amount }),
        ...(asString(record.target) === undefined
          ? {}
          : { target: asString(record.target) as string }),
      };
    }

    case 'key_press':
    case 'press':
    case 'keyboard': {
      const keys = asString(record.keys) ?? asString(record.key);
      if (keys === undefined) return fail('key_press needs "keys", e.g. "Enter"');
      return { ...base, type: 'key_press', keys };
    }

    case 'goto_url':
    case 'goto':
    case 'navigate': {
      const url = asString(record.url);
      if (url === undefined) return fail('goto_url needs a "url"');
      return { ...base, type: 'goto_url', url };
    }

    case 'go_back':
    case 'back':
      return { ...base, type: 'go_back' };

    case 'go_forward':
    case 'forward':
      return { ...base, type: 'go_forward' };

    case 'request_user_input':
    case 'ask_user':
    case 'ask': {
      const placeholderId =
        asString(record.placeholderId) ?? asString(record.placeholder_id) ?? 'USER_INPUT_1';
      const reason =
        asString(record.reason) ?? asString(record.message) ?? 'The agent needs a value.';
      const piiType = parsePiiType(record.piiType ?? record.pii_type);
      return {
        ...base,
        type: 'request_user_input',
        category: parseCategory(record.category),
        reason,
        placeholderId,
        ...(piiType === undefined ? {} : { piiType }),
      };
    }

    case 'stop':
    case 'done':
    case 'finish': {
      const answer = asString(record.answer) ?? asString(record.result) ?? '';
      return {
        ...base,
        type: 'stop',
        answer,
        ...(record.success === false ? { success: false } : { success: true }),
      };
    }

    case 'noop':
    case 'wait':
      return { ...base, type: 'noop' };

    default:
      return fail(
        `"${type}" is not an action I can perform. Use one of: click, type, select, hover, ` +
          `scroll, key_press, goto_url, go_back, request_user_input, stop.`,
      );
  }
}

/**
 * Collect the action records a reply proposes, in order.
 *
 * Four shapes are accepted because models produce all four with roughly equal
 * confidence, and none of them is ambiguous:
 *
 *   {"reasoning":…, "actions":[{…},{…}]}   the documented batch form
 *   {"reasoning":…, "action":{…}}          the documented single form
 *   {"reasoning":…, "action":[{…},{…}]}    singular key, plural value
 *   {"type":"click","target":"el_4"}       flattened, no wrapper
 *
 * Returning records rather than built actions keeps the "which shape was this" question
 * separate from the "is this a valid action" question, so a failure can name the
 * offending position.
 */
function actionRecords(
  record: Record<string, unknown>,
): Record<string, unknown>[] | ParseFailure {
  const asRecordList = (value: unknown): Record<string, unknown>[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const items: Record<string, unknown>[] = [];
    for (const item of value) {
      if (typeof item !== 'object' || item === null) return undefined;
      items.push(item as Record<string, unknown>);
    }
    return items;
  };

  const batch =
    asRecordList(record.actions) ?? asRecordList(record.action) ?? asRecordList(record.steps);
  if (batch !== undefined) {
    if (batch.length === 0) return fail('"actions" was empty. Propose at least one action.');
    return batch.slice(0, MAX_BATCH);
  }

  const inner = record.action;
  if (typeof inner === 'object' && inner !== null) return [inner as Record<string, unknown>];

  return [record];
}

export function parseAction(raw: string): ParseResult {
  const json = extractJson(raw);
  if (json === undefined) {
    return fail('No JSON object found in the reply. Reply with a single JSON object.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return fail(
      `That was not valid JSON (${error instanceof Error ? error.message : 'parse error'}).`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return fail('Reply must be a JSON object.');
  }

  // A bare array reply has no room for `reasoning`, so it is normalised into the wrapper
  // shape and everything below treats the two identically.
  const record: Record<string, unknown> = Array.isArray(parsed)
    ? { actions: parsed }
    : (parsed as Record<string, unknown>);

  const records = actionRecords(record);
  if ('ok' in records) return records;

  const actions: AgentAction[] = [];
  for (const [index, candidate] of records.entries()) {
    const built = buildAction(candidate);
    if ('ok' in built) {
      // A bad action anywhere fails the whole reply rather than silently executing the
      // prefix. Executing part of a plan the model did not get to finish describing is
      // how an agent ends up half way through a form with no idea it stopped.
      return records.length === 1
        ? built
        : fail(`action ${String(index + 1)} of ${String(records.length)}: ${built.error}`);
    }
    actions.push(built);
  }

  const first = actions[0];
  if (first === undefined) return fail('No action was proposed.');

  const reasoning = asString(record.reasoning) ?? asString(records[0]?.reasoning);
  const goal = asString(record.goal) ?? asString(record.interpreted_goal);
  const plan = asStringList(
    record.plan ?? (Array.isArray(record.steps) ? undefined : record.steps),
  );
  return {
    ok: true,
    action: first,
    actions,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(goal === undefined ? {} : { goal }),
    ...(plan === undefined ? {} : { plan }),
  };
}
