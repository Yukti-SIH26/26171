/**
 * Vault encryption.
 *
 * AES-256-GCM with a key derived from the user's passphrase by PBKDF2-SHA256.
 * Everything here uses WebCrypto — no crypto library is bundled, because a
 * hand-rolled or third-party implementation is a liability in exactly the place
 * we can least afford one.
 *
 * The choices worth defending:
 *
 *  - **GCM, not CBC.** GCM is authenticated: a tampered ciphertext fails to
 *    decrypt rather than producing plausible garbage. Since an attacker with disk
 *    access could otherwise flip bits in a stored Aadhaar number and have the
 *    agent type the result somewhere, authentication is not optional.
 *
 *  - **A fresh random IV per encryption, stored alongside the ciphertext.** IV
 *    reuse under GCM is catastrophic — it leaks the XOR of plaintexts and breaks
 *    authentication entirely. Deriving the IV from anything deterministic would
 *    reintroduce that risk, so it is always 12 random bytes.
 *
 *  - **The key is never persisted.** It lives in a module-local variable that
 *    dies with the page. Closing the side panel therefore locks the vault, which
 *    is the behaviour we want anyway.
 *
 *  - **`extractable: false`.** The derived key cannot be read back out of
 *    WebCrypto, so even code running in this page cannot exfiltrate it — only use
 *    it. That limits the damage from a successful content-script injection.
 *
 * The iteration count is a deliberate trade. 600,000 is above OWASP's 2023 floor
 * for PBKDF2-SHA256 and costs roughly a second on a low-end machine, which is
 * acceptable for an unlock that happens once per session.
 */

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

/**
 * Envelope format version.
 *
 * Stored with the ciphertext so a future change to the KDF or cipher can be
 * detected and migrated rather than silently mis-decrypting.
 */
export const ENVELOPE_VERSION = 1 as const;

export interface Envelope {
  readonly v: typeof ENVELOPE_VERSION;
  /** Base64 PBKDF2 salt. Not secret; must be stable for a given vault. */
  readonly salt: string;
  /** Base64 AES-GCM IV. Fresh on every write. */
  readonly iv: string;
  /** Base64 ciphertext with the GCM tag appended. */
  readonly data: string;
  readonly iterations: number;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked to avoid blowing the argument limit on a large vault.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function newSalt(): string {
  return toBase64(randomBytes(SALT_BYTES));
}

/**
 * Derive the encryption key from a passphrase.
 *
 * `extractable: false` means the resulting key object can be used but never read,
 * so the raw key material never exists as JavaScript-visible bytes.
 */
export async function deriveKey(
  passphrase: string,
  saltB64: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: fromBase64(saltB64) as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    // Not extractable: usable for encrypt/decrypt, impossible to read out.
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJson(
  key: CryptoKey,
  saltB64: string,
  value: unknown,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<Envelope> {
  // A fresh IV on every single write. Reuse under GCM is not a weakness, it is a
  // total break, so this must never be cached or derived.
  const iv = randomBytes(IV_BYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));

  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    plaintext as unknown as BufferSource,
  );

  // Best-effort wipe of the plaintext copy. Not a guarantee — the string handed
  // to TextEncoder is still garbage-collected normally — but it removes the
  // longest-lived copy we control.
  plaintext.fill(0);

  return {
    v: ENVELOPE_VERSION,
    salt: saltB64,
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(cipher)),
    iterations,
  };
}

/**
 * Decrypt an envelope.
 *
 * Returns `undefined` on any failure rather than throwing, because the only
 * realistic cause is a wrong passphrase and the caller needs to treat that as an
 * expected outcome. Distinguishing "wrong passphrase" from "corrupt data" would
 * leak information about the stored bytes, so both look the same from here.
 */
export async function decryptJson<T>(
  key: CryptoKey,
  envelope: Envelope,
): Promise<T | undefined> {
  if (envelope.v !== ENVELOPE_VERSION) return undefined;

  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.iv) as unknown as BufferSource },
      key,
      fromBase64(envelope.data) as unknown as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return undefined;
  }
}

/**
 * Generate a random key and export it as raw bytes.
 *
 * Used for the no-passphrase mode, where the extension keeps its own key so the
 * vault works with zero setup. Be clear-eyed about what that buys: the key ends up
 * stored near the data, so it defeats casual reading of the profile folder — a
 * backup, a grep, someone poking around a shared machine — and does not defeat a
 * determined attacker who knows where to look. The UI says exactly that.
 *
 * `extractable: true` here, unlike the passphrase path, because the whole point is
 * that we have to persist it.
 */
export async function generateDeviceKey(): Promise<{ key: CryptoKey; raw: string }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: KEY_BITS }, true, [
    'encrypt',
    'decrypt',
  ]);
  const raw = await crypto.subtle.exportKey('raw', key);
  return { key, raw: toBase64(new Uint8Array(raw)) };
}

/** Re-import a stored device key. */
export async function importDeviceKey(rawB64: string): Promise<CryptoKey | undefined> {
  try {
    return await crypto.subtle.importKey(
      'raw',
      fromBase64(rawB64) as unknown as BufferSource,
      { name: 'AES-GCM', length: KEY_BITS },
      // Not re-exportable once imported: nothing needs to read it out again.
      false,
      ['encrypt', 'decrypt'],
    );
  } catch {
    return undefined;
  }
}

/**
 * Is a passphrase strong enough to be worth deriving a key from?
 *
 * Length-first, because for a passphrase protecting a local file length beats
 * character-class rules. Returns a reason so the UI can explain rather than just
 * reject.
 */
export function assessPassphrase(passphrase: string): { ok: boolean; reason?: string } {
  if (passphrase.length < 10) {
    return {
      ok: false,
      reason: 'Use at least 10 characters. Length matters more than symbols.',
    };
  }
  if (/^\d+$/.test(passphrase)) {
    return { ok: false, reason: 'Digits only is guessable. Add words.' };
  }
  if (new Set(passphrase).size < 5) {
    return { ok: false, reason: 'Too few distinct characters.' };
  }
  return { ok: true };
}

export { PBKDF2_ITERATIONS };
