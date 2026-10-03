/**
 * The vault store.
 *
 * Holds the user's own sensitive values, encrypted at rest, and enforces the
 * three lifetimes. The enforcement is the point of this module — the encryption
 * is handled next door.
 *
 * How the lifetimes are actually enforced, rather than merely documented:
 *
 *   ephemeral   never enters `persisted`. `writeToDisk` filters on
 *               `isPersistable` before serialising, so an OTP cannot reach
 *               storage even if a caller asks it to. They live in a separate
 *               in-memory map that is not part of the encrypted blob at all.
 *   session     stored encrypted like anything else, but `reveal()` refuses
 *               without a fresh passphrase confirmation. A side panel left open
 *               is therefore not a standing login.
 *   persistent  readable while unlocked.
 *
 * Locking drops the key and every decrypted value. Because the key is a
 * non-extractable `CryptoKey` in a page-local variable, closing the panel locks
 * the vault for free.
 */

import {
  VaultAuthError,
  VaultLockedError,
  isPersistable,
  needsReauth,
  policyFor,
  summarise,
  type PiiType,
  type VaultEntry,
  type VaultSlot,
  type VaultStatus,
  type VaultSummary,
} from '@sih/core';
import type { KnownValue } from '../pii/known-values.ts';
import {
  assessPassphrase,
  decryptJson,
  deriveKey,
  encryptJson,
  generateDeviceKey,
  importDeviceKey,
  newSalt,
  PBKDF2_ITERATIONS,
  type Envelope,
} from './crypto.ts';

/** Storage keys. Only the envelope and non-secret metadata are ever written. */
const STORAGE_KEY = 'kavach.vault.v1';
const META_KEY = 'kavach.vault.meta.v1';

/**
 * How the encryption key is obtained.
 *
 *  - `device`:     the extension generated it and stores it alongside the data.
 *                  Zero setup, works immediately. Defeats casual reading of the
 *                  profile folder; does not defeat someone who knows where to look.
 *  - `passphrase`: derived from the user's passphrase and never stored. Real
 *                  protection, at the cost of having to type it.
 *
 * `device` is the default because a vault nobody fills in protects nothing: the
 * stored values are what let the redactor recognise a name or an address, so
 * friction here directly costs privacy elsewhere.
 */
export type KeyMode = 'device' | 'passphrase';

interface VaultMeta {
  readonly mode: KeyMode;
  readonly salt: string;
  readonly iterations: number;
  /** Present only in `device` mode. The key, stored next to the ciphertext. */
  readonly deviceKey?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Shape of the decrypted payload. */
interface VaultPayload {
  readonly entries: readonly VaultEntry[];
}

type StorageArea = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

/**
 * Resolve `storage.local` from whichever extension namespace exists.
 *
 * Written defensively so this module can be imported in a test environment with
 * no extension APIs; the methods throw only if actually called there.
 */
function storage(): StorageArea {
  const globals = globalThis as {
    chrome?: { storage?: { local?: StorageArea } };
    browser?: { storage?: { local?: StorageArea } };
  };
  const area = globals.chrome?.storage?.local ?? globals.browser?.storage?.local;
  if (area === undefined) {
    throw new Error('extension storage is unavailable, cannot persist the vault');
  }
  return area;
}

// ---------------------------------------------------------------------------
// In-memory state. None of this survives the page.
// ---------------------------------------------------------------------------

let key: CryptoKey | undefined;
let meta: VaultMeta | undefined;
let persisted: VaultEntry[] = [];

/**
 * One-time secrets, held separately from `persisted` so they are structurally
 * excluded from anything that gets encrypted and written.
 */
const ephemeral = new Map<VaultSlot, VaultEntry>();

function nowMs(): number {
  return Date.now();
}

function requireUnlocked(operation: string): CryptoKey {
  if (key === undefined) throw new VaultLockedError(operation);
  return key;
}

async function loadMeta(): Promise<VaultMeta | undefined> {
  const raw = await storage().get([META_KEY]);
  const value = raw[META_KEY];
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<VaultMeta>;
  if (typeof candidate.salt !== 'string' || typeof candidate.iterations !== 'number') {
    return undefined;
  }
  return {
    // Vaults written before the mode existed were passphrase-derived.
    mode: candidate.mode === 'device' ? 'device' : 'passphrase',
    salt: candidate.salt,
    iterations: candidate.iterations,
    ...(typeof candidate.deviceKey === 'string' ? { deviceKey: candidate.deviceKey } : {}),
    createdAt: candidate.createdAt ?? 0,
    updatedAt: candidate.updatedAt ?? 0,
  };
}

/**
 * Write the encrypted vault.
 *
 * The filter on `isPersistable` is the structural guarantee that no ephemeral
 * secret is ever serialised. It is applied here, at the single write path, rather
 * than trusted to every caller.
 */
async function writeToDisk(): Promise<void> {
  const activeKey = requireUnlocked('saving');
  if (meta === undefined) throw new Error('vault metadata missing');

  const writable = persisted.filter((entry) => isPersistable(entry.piiType));
  const payload: VaultPayload = { entries: writable };
  const envelope = await encryptJson(activeKey, meta.salt, payload, meta.iterations);

  const updated: VaultMeta = { ...meta, updatedAt: nowMs() };
  meta = updated;

  await storage().set({ [STORAGE_KEY]: envelope, [META_KEY]: updated });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function status(): Promise<VaultStatus> {
  if (key !== undefined) return 'unlocked';
  const existing = meta ?? (await loadMeta());
  return existing === undefined ? 'uninitialised' : 'locked';
}

/** Which protection mode an existing vault uses, if there is one. */
export async function keyMode(): Promise<KeyMode | undefined> {
  const existing = meta ?? (await loadMeta());
  return existing?.mode;
}

/**
 * Open the vault with no input from the user.
 *
 * Creates one in `device` mode on first call, then reopens it on every later call.
 * This is what makes the vault usable the instant the panel opens: a vault that
 * demands setup before it holds anything is a vault that stays empty, and an empty
 * vault means the redactor cannot recognise the user's own name.
 *
 * Returns `false` when the existing vault is passphrase-protected, because then
 * only the user can open it.
 */
export async function openAutomatically(): Promise<boolean> {
  if (key !== undefined) return true;

  const existing = meta ?? (await loadMeta());

  if (existing === undefined) {
    const { key: fresh, raw } = await generateDeviceKey();
    const created: VaultMeta = {
      mode: 'device',
      salt: newSalt(),
      iterations: PBKDF2_ITERATIONS,
      deviceKey: raw,
      createdAt: nowMs(),
      updatedAt: nowMs(),
    };
    key = fresh;
    meta = created;
    persisted = [];
    await writeToDisk();
    return true;
  }

  if (existing.mode !== 'device' || existing.deviceKey === undefined) return false;

  const restored = await importDeviceKey(existing.deviceKey);
  if (restored === undefined) return false;

  const raw = await storage().get([STORAGE_KEY]);
  const envelope = raw[STORAGE_KEY] as Envelope | undefined;

  if (envelope === undefined) {
    key = restored;
    meta = existing;
    persisted = [];
    return true;
  }

  const payload = await decryptJson<VaultPayload>(restored, envelope);
  if (payload === undefined) {
    // The stored key does not open the stored data. Refusing rather than silently
    // starting fresh, because that would destroy whatever is in there.
    return false;
  }

  key = restored;
  meta = existing;
  persisted = [...payload.entries];
  return true;
}

export async function summary(): Promise<VaultSummary & { readonly mode?: KeyMode }> {
  const current = await status();
  const all = current === 'unlocked' ? [...persisted, ...ephemeral.values()] : [];
  const base = summarise(all, current, meta?.updatedAt);
  return meta === undefined ? base : { ...base, mode: meta.mode };
}

/**
 * Create a vault for the first time, protected by a passphrase.
 *
 * Only reached when the user opts into passphrase protection. Rejects a weak one
 * outright: there is no recovery path, so accepting `1234` would be actively
 * misleading about what it protects.
 */
export async function initialise(passphrase: string): Promise<void> {
  if ((await status()) !== 'uninitialised') {
    throw new Error('vault already exists');
  }
  const verdict = assessPassphrase(passphrase);
  if (!verdict.ok) throw new Error(verdict.reason ?? 'passphrase rejected');

  const salt = newSalt();
  const created: VaultMeta = {
    mode: 'passphrase',
    salt,
    iterations: PBKDF2_ITERATIONS,
    createdAt: nowMs(),
    updatedAt: nowMs(),
  };

  key = await deriveKey(passphrase, salt, created.iterations);
  meta = created;
  persisted = [];
  await writeToDisk();
}

/**
 * Add passphrase protection to a vault that currently has none.
 *
 * Re-encrypts the existing entries under the derived key and deletes the stored
 * device key, which is the step that actually changes the security properties —
 * leaving it behind would make the passphrase decorative.
 */
export async function upgradeToPassphrase(passphrase: string): Promise<void> {
  requireUnlocked('adding a passphrase');
  if (meta === undefined) throw new Error('vault metadata missing');
  if (meta.mode === 'passphrase') throw new Error('this vault already has a passphrase');

  const verdict = assessPassphrase(passphrase);
  if (!verdict.ok) throw new Error(verdict.reason ?? 'passphrase rejected');

  const salt = newSalt();
  const derived = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);

  key = derived;
  meta = {
    mode: 'passphrase',
    salt,
    iterations: PBKDF2_ITERATIONS,
    createdAt: meta.createdAt,
    updatedAt: nowMs(),
  };
  await writeToDisk();
}

/**
 * Drop passphrase protection, going back to a stored device key.
 *
 * Requires the vault to be open, so only someone who already knows the passphrase
 * can weaken it.
 */
export async function downgradeToDeviceKey(): Promise<void> {
  requireUnlocked('removing the passphrase');
  if (meta === undefined) throw new Error('vault metadata missing');
  if (meta.mode === 'device') return;

  const { key: fresh, raw } = await generateDeviceKey();
  key = fresh;
  meta = {
    mode: 'device',
    salt: meta.salt,
    iterations: meta.iterations,
    deviceKey: raw,
    createdAt: meta.createdAt,
    updatedAt: nowMs(),
  };
  await writeToDisk();
}

/**
 * Unlock an existing vault.
 *
 * A wrong passphrase produces a `VaultAuthError`, and the key is dropped rather
 * than left half-set — otherwise a failed unlock would leave a useless key in
 * memory that later operations would treat as valid.
 */
export async function unlock(passphrase: string): Promise<void> {
  const existing = meta ?? (await loadMeta());
  if (existing === undefined) throw new Error('no vault to unlock');
  if (existing.mode === 'device') {
    // No passphrase exists; the correct entry point is `openAutomatically`.
    if (!(await openAutomatically())) throw new Error('could not open the vault');
    return;
  }

  const candidate = await deriveKey(passphrase, existing.salt, existing.iterations);
  const raw = await storage().get([STORAGE_KEY]);
  const envelope = raw[STORAGE_KEY] as Envelope | undefined;
  if (envelope === undefined) {
    // Metadata without ciphertext: treat as an empty vault rather than an error,
    // so a half-finished initialise is recoverable.
    key = candidate;
    meta = existing;
    persisted = [];
    return;
  }

  const payload = await decryptJson<VaultPayload>(candidate, envelope);
  if (payload === undefined) {
    key = undefined;
    throw new VaultAuthError();
  }

  key = candidate;
  meta = existing;
  persisted = [...payload.entries];
}

/**
 * Drop the key and every decrypted value.
 *
 * Ephemeral secrets go too: they exist only to be used once, and a lock is a
 * clear signal that the session is over.
 */
export function lock(): void {
  key = undefined;
  persisted = [];
  ephemeral.clear();
}

/** Confirm a passphrase without changing lock state, for session-gated reveals. */
export async function verifyPassphrase(passphrase: string): Promise<boolean> {
  const existing = meta ?? (await loadMeta());
  if (existing === undefined) return false;
  // Nothing to verify against when no passphrase was ever set.
  if (existing.mode === 'device') return false;

  const candidate = await deriveKey(passphrase, existing.salt, existing.iterations);
  const raw = await storage().get([STORAGE_KEY]);
  const envelope = raw[STORAGE_KEY] as Envelope | undefined;
  if (envelope === undefined) return true;
  return (await decryptJson<VaultPayload>(candidate, envelope)) !== undefined;
}

/** Destroy the vault. Irreversible — there is no key escrow by design. */
export async function destroy(): Promise<void> {
  lock();
  meta = undefined;
  await storage().remove([STORAGE_KEY, META_KEY]);
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/**
 * Entry metadata, with values withheld.
 *
 * This is what the UI lists. Rendering values in a list would put every secret on
 * screen at once for no reason; revealing one is a deliberate, separate action.
 */
export interface EntryView {
  readonly slot: VaultSlot;
  readonly piiType: PiiType;
  readonly label: string;
  readonly lifetime: 'persistent' | 'session' | 'ephemeral';
  /** Character count, so the UI can show shape without content. */
  readonly length: number;
  readonly updatedAt: number;
  /** The one site this value may be used on, when it is a credential. */
  readonly site?: string;
  readonly usedOn: readonly string[];
  /** Revealing requires the passphrase again. */
  readonly gated: boolean;
}

export function list(): EntryView[] {
  if (key === undefined) return [];
  const all = [...persisted, ...ephemeral.values()];
  return all
    .map((entry) => ({
      slot: entry.slot,
      piiType: entry.piiType,
      label: entry.label,
      lifetime: policyFor(entry.piiType).lifetime,
      length: entry.value.length,
      updatedAt: entry.updatedAt,
      ...(entry.site === undefined ? {} : { site: entry.site }),
      usedOn: entry.usedOn,
      gated: needsReauth(entry.piiType),
    }))
    .sort((a, b) => a.piiType.localeCompare(b.piiType) || a.label.localeCompare(b.label));
}

/**
 * Mint a slot id.
 *
 * Derived from the type and a counter, deliberately **not** from the label.
 *
 * The slot is not private bookkeeping: `slotToken()` turns it into the placeholder the
 * remote model sees, so whatever ends up in a slot ends up on the wire. Slugifying the
 * label meant a user who labelled an entry with the value itself — "21CS042", which is
 * a perfectly natural thing to type — produced the token
 * `REGISTRATION_NUMBER_21CS042`. The value was then transmitted inside the very token
 * that exists to avoid transmitting it, and the leak canary aborted the task with
 * nothing in the page to blame.
 *
 * A counter cannot carry content, which is the only property that actually matters
 * here. Labels stay free-text and stay local.
 */
function makeSlot(piiType: PiiType): VaultSlot {
  const stem = piiType.replace(/_/g, '');
  const taken = new Set([...persisted, ...ephemeral.values()].map((e) => e.slot));

  // Disambiguate rather than overwrite: two entries of the same type are a normal
  // thing to have, not a reason to lose one.
  let n = 1;
  let candidate = `${stem}${String(n)}`;
  while (taken.has(candidate)) candidate = `${stem}${String(++n)}`;
  return candidate;
}

/** Compare loosely: case, spaces, hyphens and underscores are all noise here. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * Why this value cannot be stored, or `undefined` if it can.
 *
 * Beyond the obvious empty check, two specific mistakes are refused, and both come from
 * the same slip: typing into the wrong box while setting up.
 *
 * A value equal to its own type name — `registration_number` stored *as* a registration
 * number — or equal to its label is not data. It is a description of the field that was
 * entered into the field. Storing it does active harm rather than nothing: every value
 * in here becomes a literal the redactor searches every page for, so a junk entry whose
 * text happens to be a common word or one of our own identifiers makes the redactor
 * find "secrets" everywhere. One such entry ended every agent run until it was tracked
 * down, which is a long way to travel for a typo that could have been refused here.
 */
function rejectionReason(piiType: PiiType, label: string, value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return 'Enter the value itself, not a description of it.';

  if (normalise(trimmed) === normalise(piiType)) {
    return `That is the name of the field, not a value. Enter the actual ${piiType.replace(/_/g, ' ')}.`;
  }
  if (label.trim() !== '' && normalise(trimmed) === normalise(label)) {
    return 'That is the label, not the value. Enter what should be typed into the page.';
  }
  return undefined;
}

export interface PutOptions {
  readonly piiType: PiiType;
  readonly label: string;
  readonly value: string;
  /** Replace an existing entry instead of adding a new one. */
  readonly slot?: VaultSlot;
  /**
   * Origin this value belongs to. Set when the value was captured on a specific
   * site, which is what later refuses it everywhere else.
   */
  readonly site?: string;
}

/**
 * Add or update an entry.
 *
 * Ephemeral types are routed to the in-memory map and never touch disk, which is
 * why this returns the slot rather than the entry: the caller should not be
 * holding the value any longer than it has to.
 */
export async function put(options: PutOptions): Promise<VaultSlot> {
  requireUnlocked('saving a value');

  const { piiType, label, value } = options;
  const rejection = rejectionReason(piiType, label, value);
  if (rejection !== undefined) throw new Error(rejection);

  const slot = options.slot ?? makeSlot(piiType);
  const existing = persisted.find((e) => e.slot === slot) ?? ephemeral.get(slot);

  // An explicit site wins; otherwise keep whatever the entry was already bound to,
  // so an edit to the label cannot quietly unbind a credential.
  const site = options.site ?? existing?.site;

  const entry: VaultEntry = {
    slot,
    piiType,
    label: label === '' ? piiType.replace(/_/g, ' ') : label,
    value,
    createdAt: existing?.createdAt ?? nowMs(),
    updatedAt: nowMs(),
    ...(site === undefined || site === '' ? {} : { site }),
    usedOn: existing?.usedOn ?? [],
  };

  if (!isPersistable(piiType)) {
    // One-time secrets: memory only, and they replace rather than accumulate.
    ephemeral.set(slot, entry);
    return slot;
  }

  const index = persisted.findIndex((e) => e.slot === slot);
  if (index >= 0) persisted[index] = entry;
  else persisted.push(entry);

  await writeToDisk();
  return slot;
}

export async function remove(slot: VaultSlot): Promise<void> {
  requireUnlocked('deleting a value');

  if (ephemeral.delete(slot)) return;

  const before = persisted.length;
  persisted = persisted.filter((e) => e.slot !== slot);
  if (persisted.length !== before) await writeToDisk();
}

/**
 * Read a value back.
 *
 * `passphrase` is required for session-lifetime entries. Without it this refuses,
 * which is what makes an open side panel not equivalent to being logged in.
 */
export async function reveal(slot: VaultSlot, passphrase?: string): Promise<string> {
  requireUnlocked('reading a value');

  const entry = persisted.find((e) => e.slot === slot) ?? ephemeral.get(slot);
  if (entry === undefined) throw new Error(`no vault entry "${slot}"`);

  // Re-auth only means something when there is a passphrase to re-enter. In device
  // mode the key is already on disk, so demanding one would be theatre: it would
  // add friction without adding protection.
  if (meta?.mode === 'passphrase' && needsReauth(entry.piiType)) {
    if (passphrase === undefined) {
      throw new VaultLockedError(`revealing ${entry.piiType} (re-enter the passphrase)`);
    }
    if (!(await verifyPassphrase(passphrase))) throw new VaultAuthError();
  }

  return entry.value;
}

/**
 * Consume a one-time secret.
 *
 * Returns the value and deletes it in the same step, so it cannot be used twice.
 * An OTP that survives its use is a bearer token sitting in memory.
 */
export function consumeEphemeral(slot: VaultSlot): string | undefined {
  const entry = ephemeral.get(slot);
  if (entry === undefined) return undefined;
  ephemeral.delete(slot);
  return entry.value;
}

/**
 * Record that a value was used on an origin, binding it there if it was unbound.
 *
 * The binding is the security-relevant half. Once a credential has a site, every
 * later use is checked against it, so this call is what converts "not yet known"
 * into "only ever here".
 */
export async function recordUse(slot: VaultSlot, origin: string): Promise<void> {
  requireUnlocked('recording usage');

  const index = persisted.findIndex((e) => e.slot === slot);
  const entry = persisted[index];
  if (index < 0 || entry === undefined) return;

  const bindTo = entry.site === undefined && policyFor(entry.piiType).confirmBeforeUse;
  const alreadyLogged = entry.usedOn.includes(origin);
  if (!bindTo && alreadyLogged) return;

  persisted[index] = {
    ...entry,
    ...(bindTo ? { site: origin } : {}),
    usedOn: alreadyLogged ? entry.usedOn : [...entry.usedOn, origin],
    updatedAt: nowMs(),
  };
  await writeToDisk();
}

/** Point a credential at a different site, or unbind it. Only the user may do this. */
export async function rebind(slot: VaultSlot, site: string | undefined): Promise<void> {
  requireUnlocked('changing the site');

  const index = persisted.findIndex((e) => e.slot === slot);
  const entry = persisted[index];
  if (index < 0 || entry === undefined) return;

  const { site: _previous, ...rest } = entry;
  persisted[index] = {
    ...rest,
    ...(site === undefined || site === '' ? {} : { site }),
    updatedAt: nowMs(),
  };
  await writeToDisk();
}

// ---------------------------------------------------------------------------
// Redaction dictionary
// ---------------------------------------------------------------------------

/**
 * Project the vault into the detector's input shape.
 *
 * This is the vault's second job, and the reason it makes the system *more*
 * private rather than less: every value stored here is a value the known-value
 * detector can find and redact with certainty, including ones no pattern covers.
 *
 * Ephemeral secrets are included. An OTP visible on screen still has to be
 * redacted before the screenshot leaves, even though it is never written to disk.
 *
 * Returns an empty list when locked — detection degrades to patterns and structure
 * rather than failing, which is the right trade for a user who has not unlocked.
 */
export function asRedactionDictionary(): readonly KnownValue[] {
  if (key === undefined) return [];
  return [...persisted, ...ephemeral.values()].map((entry) => ({
    piiType: entry.piiType,
    value: entry.value,
    slot: entry.slot,
  }));
}

/** Look up an entry by the placeholder token the server used. */
export function findByToken(token: string): EntryView | undefined {
  const upper = token.toUpperCase();
  return list().find(
    (view) => `${view.piiType.toUpperCase()}_${view.slot.toUpperCase()}` === upper,
  );
}

/** Test seam: reset module state without touching storage. */
export function resetForTesting(): void {
  key = undefined;
  meta = undefined;
  persisted = [];
  ephemeral.clear();
}
