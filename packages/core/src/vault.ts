/**
 * Vault contracts.
 *
 * The vault is the user's own copy of their sensitive data, and it does two jobs
 * that pull in opposite directions everywhere else in this system:
 *
 *  1. It lets the agent *fill in* a value the remote model asked for by
 *     placeholder, so the model never needs to see it.
 *  2. It doubles as the redaction dictionary. Knowing that `4321 8765 2109` is
 *     this user's Aadhaar number makes the known-value detector both more
 *     complete and more precise than any pattern — it finds values no regex
 *     covers, and it never fires on a lookalike.
 *
 * That second job is why the vault is a privacy *asset* rather than a privacy
 * liability: the more it holds, the less leaks.
 *
 * The lifetime rules are the load-bearing part of the design:
 *
 *   persistent  encrypted at rest, decrypted while unlocked. Aadhaar, name.
 *   session     encrypted at rest, but using it requires re-entering the
 *               passphrase. Passwords — so a left-open panel is not a login.
 *   ephemeral   never written to disk under any circumstances, held in memory,
 *               wiped after a single use. OTPs and CVVs. A stored OTP is both
 *               useless (it expires) and a liability (it is a bearer token).
 *
 * `ephemeral` is enforced structurally rather than by convention: the type of a
 * persistable record cannot carry an ephemeral value, so a future contributor
 * cannot accidentally write one to storage.
 */

import { isEphemeral, policyFor, type PiiType } from './pii.ts';

/** Stable handle for one stored value. Also forms the placeholder the server sees. */
export type VaultSlot = string;

export interface VaultEntry {
  readonly slot: VaultSlot;
  readonly piiType: PiiType;
  /** Human label, e.g. "College portal password". Never leaves the device. */
  readonly label: string;
  /** The secret itself. Never leaves the device. */
  readonly value: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * The origin this value belongs to, e.g. `https://www.digilocker.gov.in`.
   *
   * Set for credentials — things that only mean anything on one site. Absent for
   * profile data like a name or an Aadhaar number, which the user may legitimately
   * enter anywhere.
   *
   * This field is what replaced an "are you sure?" dialog. A bound credential is
   * used silently on its own origin and refused everywhere else, so the user is
   * never asked to adjudicate a domain name they have no way to verify.
   */
  readonly site?: string;
  /** Origins this value has been used on. Kept for the audit trail only. */
  readonly usedOn: readonly string[];
}

/**
 * An entry that may be written to disk.
 *
 * The excluded-lifetime constraint is expressed in the type so the storage layer
 * physically cannot accept an ephemeral secret.
 */
export type PersistableEntry = VaultEntry & { readonly __persistable: true };

export type VaultStatus =
  /** No vault exists yet; the user has not set a passphrase. */
  | 'uninitialised'
  /** Ciphertext on disk, no key in memory. Nothing readable. */
  | 'locked'
  /** Key in memory, values readable. */
  | 'unlocked';

export interface VaultSummary {
  readonly status: VaultStatus;
  readonly entryCount: number;
  /** Counts by lifetime, so the UI can be honest about what is on disk. */
  readonly persistentCount: number;
  readonly sessionCount: number;
  readonly ephemeralCount: number;
  readonly updatedAt?: number;
}

/**
 * Can this value be written to disk at all?
 *
 * The single gate every persistence path must pass through.
 */
export function isPersistable(piiType: PiiType): boolean {
  return !isEphemeral(piiType);
}

/**
 * Narrow an entry to a persistable one, or refuse.
 *
 * Returns `undefined` rather than throwing so the caller has to handle the
 * ephemeral case explicitly instead of letting an exception decide.
 */
export function asPersistable(entry: VaultEntry): PersistableEntry | undefined {
  if (!isPersistable(entry.piiType)) return undefined;
  return entry as PersistableEntry;
}

/**
 * Is this value allowed to be used on this origin?
 *
 *   `use`     go ahead, silently. Either the value is not site-specific, or this is
 *             the site it belongs to.
 *   `bind`    site-specific, not yet bound to anything. Using it here claims it for
 *             this origin, and every later use is checked against that.
 *   `refuse`  it belongs to a different site. Not negotiable and not promptable.
 *
 * Binding on first use rather than asking is a deliberate trade. The alternative —
 * a confirmation dialog — moves the phishing decision onto the user at the exact
 * moment they are least able to make it, and in practice trains them to click
 * through. First use is no more exposed than the user typing the value in
 * themselves, and every use after that is protected by a check they cannot
 * accidentally waive.
 */
export type SiteVerdict = 'use' | 'bind' | 'refuse';

export function siteVerdict(entry: VaultEntry, origin: string): SiteVerdict {
  // Not a credential: a name or a postcode is the user's to type anywhere.
  if (!policyFor(entry.piiType).confirmBeforeUse) return 'use';
  if (entry.site === undefined || entry.site === '') return 'bind';
  return entry.site === origin ? 'use' : 'refuse';
}

/** Does using this value require re-entering the passphrase? */
export function needsReauth(piiType: PiiType): boolean {
  return policyFor(piiType).lifetime === 'session';
}

/**
 * Build the placeholder token for a slot.
 *
 * Deliberately type-revealing and value-hiding. The remote model needs to know
 * that *an Aadhaar number* belongs in a field to reason about the form, and needs
 * a stable name to refer to it across turns. It must never learn the digits.
 */
export function slotToken(piiType: PiiType, slot: VaultSlot): string {
  return `${piiType.toUpperCase()}_${slot.toUpperCase()}`;
}

/**
 * Summarise a set of entries without exposing any value.
 *
 * Used for anything that might be logged or rendered: it is safe to show a
 * summary anywhere, which is not true of the entries themselves.
 */
export function summarise(
  entries: readonly VaultEntry[],
  status: VaultStatus,
  updatedAt?: number,
): VaultSummary {
  let persistentCount = 0;
  let sessionCount = 0;
  let ephemeralCount = 0;

  for (const entry of entries) {
    switch (policyFor(entry.piiType).lifetime) {
      case 'persistent':
        persistentCount++;
        break;
      case 'session':
        sessionCount++;
        break;
      case 'ephemeral':
        ephemeralCount++;
        break;
    }
  }

  return {
    status,
    entryCount: entries.length,
    persistentCount,
    sessionCount,
    ephemeralCount,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

/** Thrown when an operation needs the vault unlocked and it is not. */
export class VaultLockedError extends Error {
  constructor(operation: string) {
    super(`Vault is locked: ${operation} needs the passphrase first`);
    this.name = 'VaultLockedError';
  }
}

/** Thrown when the passphrase does not decrypt the vault. */
export class VaultAuthError extends Error {
  constructor() {
    // Deliberately says nothing about how close the attempt was.
    super('Incorrect passphrase');
    this.name = 'VaultAuthError';
  }
}
