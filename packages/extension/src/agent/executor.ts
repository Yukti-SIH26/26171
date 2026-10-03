/**
 * The executor: the only place a secret becomes plaintext.
 *
 * Sequence for every action, in this order and for these reasons:
 *
 *   1. validate   against the *current* page, not the one the model saw
 *   2. resolve    placeholder -> value, from the unlocked vault
 *   3. dispatch   to the content script
 *   4. forget     drop the local reference immediately
 *
 * Resolution deliberately happens after validation and immediately before
 * dispatch. Doing it earlier would mean a rejected action had already
 * materialised a password in memory for no reason. The window in which the
 * plaintext exists is one function call wide.
 *
 * Values never appear in the returned record, the log line, or the error message.
 * Lengths do. An audit trail that echoes the value it was protecting is not an
 * audit trail.
 */

import {
  ALL_PII_TYPES,
  isEphemeral,
  isTerminal,
  targetOf,
  type AgentAction,
  type PiiType,
  type ValidationVerdict,
} from '@sih/core';
import type { DispatchAdapter } from '@sih/core';
import type { KnownValue } from '../pii/known-values.ts';
import * as vault from '../vault/index.ts';
import { validateAction, type ValidatorContext } from './validator.ts';
import { ActionFailedError } from '../platform/dispatch-via-content.ts';

export interface StepRecord {
  readonly index: number;
  readonly action: AgentAction['type'];
  readonly target?: string;
  readonly ok: boolean;
  /** Human-readable outcome. Never contains a secret value. */
  readonly detail: string;
  readonly durationMs: number;
  /** Set when the validator refused, so the reason is auditable. */
  readonly refusedAs?: string;
  /** True when a vault value was used, without saying which or what. */
  readonly usedSecret?: boolean;
}

/**
 * Values supplied during this browser session. They live only in extension
 * `storage.session` (with an in-memory fallback), are bound to one origin on use,
 * and are never copied into model messages or persistent storage.
 */
interface SuppliedEntry {
  readonly token: string;
  readonly aliases: readonly string[];
  readonly value: string;
  readonly piiType: PiiType;
  readonly origin?: string;
}

const SESSION_VALUES_KEY = 'yukti.session-values.v1';
let memoryFallback: SuppliedEntry[] = [];

type SessionStorageArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
};

function sessionStorageArea(): SessionStorageArea | undefined {
  const globals = globalThis as {
    chrome?: { storage?: { session?: SessionStorageArea } };
    browser?: { storage?: { session?: SessionStorageArea } };
  };
  return globals.chrome?.storage?.session ?? globals.browser?.storage?.session;
}

function normaliseToken(token: string): string {
  return token.trim().toUpperCase();
}

export function piiTypeFromToken(token: string): PiiType | undefined {
  const normalized = normaliseToken(token);
  return [...ALL_PII_TYPES]
    .sort((a, b) => b.length - a.length)
    .find((type) => normalized.startsWith(type.toUpperCase()));
}

function randomLetters(length = 10): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => String.fromCharCode(65 + (value % 26))).join('');
}

function validEntry(value: unknown): value is SuppliedEntry {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<SuppliedEntry>;
  return (
    typeof item.token === 'string' &&
    Array.isArray(item.aliases) &&
    item.aliases.every((alias) => typeof alias === 'string') &&
    typeof item.value === 'string' &&
    typeof item.piiType === 'string' &&
    ALL_PII_TYPES.includes(item.piiType as PiiType) &&
    (item.origin === undefined || typeof item.origin === 'string')
  );
}

export class SuppliedValues {
  private readonly values = new Map<string, SuppliedEntry>();

  async restore(): Promise<void> {
    const area = sessionStorageArea();
    let restored = memoryFallback;
    if (area !== undefined) {
      try {
        const raw = await area.get(SESSION_VALUES_KEY);
        const candidate = raw[SESSION_VALUES_KEY];
        if (Array.isArray(candidate)) restored = candidate.filter(validEntry);
      } catch {
        // Some Firefox versions do not expose storage.session. The module-local
        // fallback still keeps values for the lifetime of this sidepanel process.
      }
    }
    for (const entry of restored) this.install(entry);
  }

  private install(entry: SuppliedEntry): void {
    this.values.set(normaliseToken(entry.token), entry);
    for (const alias of entry.aliases) this.values.set(normaliseToken(alias), entry);
  }

  private uniqueEntries(): SuppliedEntry[] {
    return [
      ...new Map([...this.values.values()].map((entry) => [entry.token, entry])).values(),
    ];
  }

  private persist(): void {
    const entries = this.uniqueEntries();
    memoryFallback = entries;
    const area = sessionStorageArea();
    if (area !== undefined)
      void area.set({ [SESSION_VALUES_KEY]: entries }).catch(() => undefined);
  }

  supply(
    placeholderId: string,
    value: string,
    options: { readonly piiType?: PiiType; readonly origin?: string } = {},
  ): string {
    const piiType = options.piiType ?? piiTypeFromToken(placeholderId) ?? 'secret_token';
    const requested = normaliseToken(placeholderId);
    const token =
      requested.startsWith(piiType.toUpperCase()) && /^[A-Z][A-Z0-9_]{2,80}$/.test(requested)
        ? requested
        : `${piiType.toUpperCase()}_LOCAL_${randomLetters()}`;
    const aliases = requested === token ? [token] : [token, requested];
    const entry: SuppliedEntry = {
      token,
      aliases,
      value,
      piiType,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    };
    this.install(entry);
    this.persist();
    return token;
  }

  private findEntry(placeholderId: string, origin?: string): SuppliedEntry | undefined {
    const direct = this.values.get(normaliseToken(placeholderId));
    if (direct !== undefined) {
      return direct.origin === undefined || origin === undefined || direct.origin === origin
        ? direct
        : undefined;
    }

    const piiType = piiTypeFromToken(placeholderId);
    if (piiType === undefined) return undefined;
    const matches = this.uniqueEntries().filter(
      (entry) =>
        entry.piiType === piiType &&
        (entry.origin === undefined || origin === undefined || entry.origin === origin),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  peek(placeholderId: string, origin?: string): string | undefined {
    return this.findEntry(placeholderId, origin)?.value;
  }

  /** Compatibility helper for one-time callers; normal execution uses markUsed. */
  consume(placeholderId: string): string | undefined {
    const value = this.peek(placeholderId);
    this.remove(placeholderId);
    return value;
  }

  has(placeholderId: string, origin?: string): boolean {
    return this.peek(placeholderId, origin) !== undefined;
  }

  tokenForType(piiType: PiiType, origin?: string): string | undefined {
    const matches = this.uniqueEntries().filter(
      (entry) =>
        entry.piiType === piiType &&
        (entry.origin === undefined || origin === undefined || entry.origin === origin),
    );
    return matches.length === 1 ? matches[0]?.token : undefined;
  }

  ids(origin?: string): string[] {
    return this.uniqueEntries()
      .filter(
        (entry) =>
          entry.origin === undefined || origin === undefined || entry.origin === origin,
      )
      .flatMap((entry) => entry.aliases);
  }

  types(origin?: string): Readonly<Record<string, PiiType>> {
    const out: Record<string, PiiType> = {};
    for (const entry of this.uniqueEntries()) {
      if (entry.origin !== undefined && origin !== undefined && entry.origin !== origin)
        continue;
      for (const alias of entry.aliases) out[normaliseToken(alias)] = entry.piiType;
    }
    return out;
  }

  asRedactionDictionary(): readonly KnownValue[] {
    return this.uniqueEntries().map((entry) => ({
      piiType: entry.piiType,
      value: entry.value,
      slot: entry.token.slice(entry.piiType.length + 1).toLowerCase(),
    }));
  }

  /** Bind reusable values after verified use; erase OTP/CVV immediately. */
  markUsed(placeholderId: string, origin: string): void {
    const entry = this.findEntry(placeholderId, origin);
    if (entry === undefined) return;
    if (isEphemeral(entry.piiType)) {
      this.remove(entry.token);
      return;
    }
    if (entry.origin === undefined) {
      const rebound: SuppliedEntry = { ...entry, origin };
      for (const alias of entry.aliases) this.values.set(normaliseToken(alias), rebound);
      this.values.set(normaliseToken(entry.token), rebound);
      this.persist();
    }
  }

  private remove(placeholderId: string): void {
    const entry = this.values.get(normaliseToken(placeholderId));
    if (entry === undefined) return;
    for (const alias of entry.aliases) this.values.delete(normaliseToken(alias));
    this.values.delete(normaliseToken(entry.token));
    this.persist();
  }

  clear(): void {
    this.values.clear();
    memoryFallback = [];
    const area = sessionStorageArea();
    if (area !== undefined) void area.remove(SESSION_VALUES_KEY).catch(() => undefined);
  }
}

export interface ExecuteOptions {
  readonly tabId: number;
  readonly action: AgentAction;
  readonly index: number;
  readonly dispatch: DispatchAdapter;
  readonly context: ValidatorContext;
  readonly supplied: SuppliedValues;
  /**
   * Prompt the user for a passphrase. Needed for session-lifetime secrets, where
   * an open panel deliberately is not a standing authorisation.
   */
  readonly requestPassphrase?: () => Promise<string | undefined>;
  /** Ask the user for a value the agent does not have. Ask, don't stop. */
  readonly requestInput?: (
    category: string,
    reason: string,
    placeholderId: string,
  ) => Promise<string | undefined>;
}

/**
 * Resolve a placeholder to a value.
 *
 * Order matters: a value the user just typed wins over a stored one, because they
 * supplied it in response to this specific prompt. Stored values then need their
 * lifetime honoured, which is where the passphrase re-prompt happens.
 */
async function resolveValue(
  placeholderId: string,
  options: ExecuteOptions,
): Promise<{ value: string } | { error: string }> {
  const supplied = options.supplied.peek(placeholderId, options.context.origin);
  if (supplied !== undefined) return { value: supplied };

  const entry = vault.findByToken(placeholderId);
  if (entry === undefined) {
    // Fall back to a unique type match: the model may say `PASSWORD_1` when the
    // vault holds exactly one password under a different slot name.
    const candidates = vault
      .list()
      .filter((v) => placeholderId.toUpperCase().startsWith(v.piiType.toUpperCase()));
    if (candidates.length !== 1 || candidates[0] === undefined) {
      const derived = await derivedNamePart(placeholderId, options);
      if (derived !== undefined) return derived;
      return { error: `no vault entry matches "${placeholderId}"` };
    }
    return resolveEntry(candidates[0].slot, candidates[0].gated, options);
  }

  return resolveEntry(entry.slot, entry.gated, options);
}

/**
 * Satisfy a first- or last-name request from a stored full name.
 *
 * Forms ask for whichever shape they please, and a user who stored "Krishna Agrawal" as
 * one value should not have to store it twice more. Without this the agent had one token
 * for two boxes and put the whole name in each, which is what a First Name reading
 * "Krishna Agrawal" was.
 *
 * Splitting happens here, at resolution time, rather than by writing extra vault
 * entries: the parts are derived rather than asserted, so if the user corrects their
 * name there is only one place to correct it.
 *
 * Deliberately conservative. A single-word name yields nothing for the family part
 * rather than guessing, because a wrong surname submits cleanly and is wrong — the worst
 * kind of output. Everything after the first token is treated as the family name, which
 * handles the common Indian and Western orderings and does not pretend to handle
 * particles or patronymics.
 */
async function derivedNamePart(
  placeholderId: string,
  options: ExecuteOptions,
): Promise<{ value: string } | undefined> {
  const upper = placeholderId.toUpperCase();
  const wantsGiven = upper.startsWith('GIVEN_NAME');
  const wantsFamily = upper.startsWith('FAMILY_NAME');
  if (!wantsGiven && !wantsFamily) return undefined;

  const full = vault.list().find((v) => v.piiType === 'person_name');
  if (full === undefined) return undefined;

  const resolved = await resolveEntry(full.slot, full.gated, options);
  if ('error' in resolved) return undefined;

  const parts = resolved.value
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '');
  if (parts.length === 0) return undefined;

  if (wantsGiven) return { value: parts[0] ?? '' };
  // One word only: there is no surname to hand over, and inventing one is worse than
  // letting the agent ask.
  if (parts.length < 2) return undefined;
  return { value: parts.slice(1).join(' ') };
}

async function resolveEntry(
  slot: string,
  gated: boolean,
  options: ExecuteOptions,
): Promise<{ value: string } | { error: string }> {
  // Session-lifetime values need the passphrase again. This is what stops a side
  // panel left open on a shared machine from being a usable login.
  if (gated) {
    if (options.requestPassphrase === undefined) {
      return { error: 'this value needs the passphrase and there is no way to ask' };
    }
    const passphrase = await options.requestPassphrase();
    if (passphrase === undefined) return { error: 'passphrase not provided' };
    try {
      return { value: await vault.reveal(slot, passphrase) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'could not read the value' };
    }
  }

  try {
    return { value: await vault.reveal(slot) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'could not read the value' };
  }
}

function refusalRecord(
  index: number,
  action: AgentAction,
  verdict: Extract<ValidationVerdict, { ok: false }>,
  startedAt: number,
): StepRecord {
  const target = targetOf(action);
  return {
    index,
    action: action.type,
    ...(target === undefined ? {} : { target }),
    ok: false,
    detail: verdict.detail,
    refusedAs: verdict.code,
    durationMs: performance.now() - startedAt,
  };
}

/**
 * Execute one validated action.
 *
 * Returns a record rather than throwing for an expected refusal, because the agent
 * loop needs to feed the reason back to the planner so it can try something else.
 * A refusal is information, not an exception.
 */
export async function executeAction(options: ExecuteOptions): Promise<StepRecord> {
  const started = performance.now();
  const { action, index, tabId, dispatch } = options;

  // ---- Ask, don't stop --------------------------------------------------
  // Handled before validation because it touches no page state: the agent has
  // hit something it cannot supply (an OTP, a CAPTCHA) and the correct behaviour
  // is to ask the user and carry on, not to abandon the task.
  if (action.type === 'request_user_input') {
    if (options.requestInput === undefined) {
      return {
        index,
        action: action.type,
        ok: false,
        detail: 'the agent needs input but there is no way to ask',
        durationMs: performance.now() - started,
      };
    }
    const value = await options.requestInput(
      action.category,
      action.reason,
      action.placeholderId,
    );
    if (value === undefined || value === '') {
      return {
        index,
        action: action.type,
        ok: false,
        detail: 'you declined to provide the value',
        durationMs: performance.now() - started,
      };
    }
    const token = options.supplied.supply(action.placeholderId, value, {
      ...(action.piiType === undefined ? {} : { piiType: action.piiType }),
      origin: options.context.origin,
    });
    return {
      index,
      action: action.type,
      ok: true,
      // Token and length only. The supplied value never enters logs.
      detail: `received ${String(value.length)} local characters for ${token}`,
      durationMs: performance.now() - started,
    };
  }

  // ---- Validate --------------------------------------------------------
  // No recovery path and no dialog. Every refusal here is either a stale target
  // the model should re-read, or a secret aimed somewhere it must not go; asking
  // the user to overrule the second kind would defeat the point of checking.
  const verdict = validateAction(action, {
    ...options.context,
    suppliedPlaceholders: options.supplied.ids(),
  });
  if (!verdict.ok) return refusalRecord(index, action, verdict, started);

  // ---- Terminal and no-op ----------------------------------------------
  if (isTerminal(action)) {
    return {
      index,
      action: action.type,
      ok: true,
      detail: action.type === 'stop' ? `finished: ${action.answer}` : 'stopped',
      durationMs: performance.now() - started,
    };
  }
  if (action.type === 'noop') {
    return {
      index,
      action: action.type,
      ok: true,
      detail: 'no action taken',
      durationMs: performance.now() - started,
    };
  }

  // ---- Resolve and dispatch -------------------------------------------
  const target = targetOf(action);
  let usedSecret = false;

  try {
    switch (action.type) {
      case 'click':
        await dispatch.click(tabId, action.target);
        break;

      case 'click_point':
        await dispatch.clickPoint(tabId, action.point);
        break;

      case 'hover':
        await dispatch.hover(tabId, action.target);
        break;

      case 'type': {
        let text: string;
        if (action.value.kind === 'literal') {
          text = action.value.text;
        } else {
          const resolved = await resolveValue(action.value.placeholderId, options);
          if ('error' in resolved) {
            return {
              index,
              action: action.type,
              ...(target === undefined ? {} : { target }),
              ok: false,
              detail: resolved.error,
              refusedAs: 'unresolvable_placeholder',
              durationMs: performance.now() - started,
            };
          }
          text = resolved.value;
          usedSecret = true;
        }

        await dispatch.typeText(tabId, action.target, text, {
          ...(action.clear === undefined ? {} : { clear: action.clear }),
          ...(action.submit === undefined ? {} : { submit: action.submit }),
        });

        // Bind the credential to this origin if it was not bound yet, and log the
        // use either way. Done after a successful type so a failed attempt cannot
        // claim a credential for the wrong site.
        if (usedSecret && action.value.kind === 'placeholder') {
          const entry = vault.findByToken(action.value.placeholderId);
          if (entry !== undefined) {
            await vault.recordUse(entry.slot, options.context.origin).catch(() => undefined);
          }
          options.supplied.markUsed(action.value.placeholderId, options.context.origin);
        }

        // Drop the local reference. The string is still subject to normal garbage
        // collection, but nothing here keeps it reachable.
        text = '';
        break;
      }

      case 'select': {
        let option: string;
        if (action.option.kind === 'literal') {
          option = action.option.text;
        } else {
          const resolved = await resolveValue(action.option.placeholderId, options);
          if ('error' in resolved) {
            return {
              index,
              action: action.type,
              ...(target === undefined ? {} : { target }),
              ok: false,
              detail: resolved.error,
              refusedAs: 'unresolvable_placeholder',
              durationMs: performance.now() - started,
            };
          }
          option = resolved.value;
          usedSecret = true;
        }
        await dispatch.selectOption(tabId, action.target, option);
        if (action.option.kind === 'placeholder') {
          options.supplied.markUsed(action.option.placeholderId, options.context.origin);
        }
        option = '';
        break;
      }

      case 'scroll': {
        const amount = action.amount ?? 600;
        const deltas: Record<string, [number, number]> = {
          up: [0, -amount],
          down: [0, amount],
          left: [-amount, 0],
          right: [amount, 0],
        };
        const [dx, dy] = deltas[action.direction] ?? [0, amount];
        await dispatch.scroll(tabId, dx, dy, action.target);
        break;
      }

      case 'key_press':
        await dispatch.pressKeys(tabId, action.keys);
        break;

      case 'goto_url':
      case 'go_back':
      case 'go_forward':
        // Navigation is the caller's job: it owns the tab and has to wait for the
        // load to settle before the next observation is meaningful.
        return {
          index,
          action: action.type,
          ok: true,
          detail: action.type === 'goto_url' ? `navigate to ${action.url}` : action.type,
          durationMs: performance.now() - started,
        };
    }
  } catch (error) {
    const failed = error instanceof ActionFailedError;
    return {
      index,
      action: action.type,
      ...(target === undefined ? {} : { target }),
      ok: false,
      detail: error instanceof Error ? error.message : 'the action failed',
      ...(failed && error.obscured ? { refusedAs: 'obscured' } : {}),
      durationMs: performance.now() - started,
      ...(usedSecret ? { usedSecret: true } : {}),
    };
  }

  return {
    index,
    action: action.type,
    ...(target === undefined ? {} : { target }),
    ok: true,
    detail: `${action.type} completed`,
    durationMs: performance.now() - started,
    ...(usedSecret ? { usedSecret: true } : {}),
  };
}
