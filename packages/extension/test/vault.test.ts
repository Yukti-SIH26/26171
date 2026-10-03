import { beforeEach, describe, expect, it } from 'vitest';
import { VaultAuthError, VaultLockedError, policyFor } from '@sih/core';
import * as vault from '../src/vault/store.ts';
import {
  assessPassphrase,
  decryptJson,
  deriveKey,
  encryptJson,
  newSalt,
} from '../src/vault/crypto.ts';

/**
 * In-memory stand-in for `chrome.storage.local`.
 *
 * Installed on `globalThis` because the store resolves the storage area lazily,
 * which is what lets it be imported outside an extension context at all.
 */
function installFakeStorage(): { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: (keys: string[]): Promise<Record<string, unknown>> => {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in data) out[k] = data[k];
          return Promise.resolve(out);
        },
        set: (items: Record<string, unknown>): Promise<void> => {
          Object.assign(data, items);
          return Promise.resolve();
        },
        remove: (keys: string[]): Promise<void> => {
          for (const k of keys) delete data[k];
          return Promise.resolve();
        },
      },
    },
  };
  return { data };
}

const PASSPHRASE = 'correct horse battery';
const AADHAAR = '432187652109';

let store: { data: Record<string, unknown> };

beforeEach(() => {
  store = installFakeStorage();
  vault.resetForTesting();
});

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

describe('crypto', () => {
  it('round-trips a value', async () => {
    const salt = newSalt();
    const key = await deriveKey(PASSPHRASE, salt, 1000);
    const envelope = await encryptJson(key, salt, { secret: AADHAAR }, 1000);
    expect(await decryptJson<{ secret: string }>(key, envelope)).toEqual({ secret: AADHAAR });
  });

  it('does not put the plaintext in the envelope', async () => {
    const salt = newSalt();
    const key = await deriveKey(PASSPHRASE, salt, 1000);
    const envelope = await encryptJson(key, salt, { secret: AADHAAR }, 1000);
    expect(JSON.stringify(envelope)).not.toContain(AADHAAR);
  });

  /**
   * IV reuse under GCM is not a weakness, it is a total break: it leaks the XOR of
   * plaintexts and destroys authentication. So a fresh IV per write is a property
   * worth asserting rather than assuming.
   */
  it('uses a fresh IV on every encryption', async () => {
    const salt = newSalt();
    const key = await deriveKey(PASSPHRASE, salt, 1000);
    const ivs = new Set<string>();
    for (let i = 0; i < 12; i++) {
      ivs.add((await encryptJson(key, salt, { i }, 1000)).iv);
    }
    expect(ivs.size).toBe(12);
  });

  it('fails to decrypt with the wrong passphrase', async () => {
    const salt = newSalt();
    const good = await deriveKey(PASSPHRASE, salt, 1000);
    const bad = await deriveKey('wrong passphrase here', salt, 1000);
    const envelope = await encryptJson(good, salt, { secret: AADHAAR }, 1000);
    expect(await decryptJson(bad, envelope)).toBeUndefined();
  });

  /**
   * GCM is authenticated, so a flipped bit must fail rather than decrypt to
   * plausible garbage. Otherwise an attacker with disk access could alter a stored
   * Aadhaar number and have the agent type the result somewhere.
   */
  it('rejects tampered ciphertext', async () => {
    const salt = newSalt();
    const key = await deriveKey(PASSPHRASE, salt, 1000);
    const envelope = await encryptJson(key, salt, { secret: AADHAAR }, 1000);

    const bytes = atob(envelope.data).split('');
    bytes[4] = String.fromCharCode((bytes[4]?.charCodeAt(0) ?? 0) ^ 0xff);
    const tampered = { ...envelope, data: btoa(bytes.join('')) };

    expect(await decryptJson(key, tampered)).toBeUndefined();
  });

  it('rejects an unknown envelope version', async () => {
    const salt = newSalt();
    const key = await deriveKey(PASSPHRASE, salt, 1000);
    const envelope = await encryptJson(key, salt, { a: 1 }, 1000);
    expect(await decryptJson(key, { ...envelope, v: 99 as 1 })).toBeUndefined();
  });

  it('rejects weak passphrases with a reason', () => {
    expect(assessPassphrase('short').ok).toBe(false);
    expect(assessPassphrase('1234567890').ok).toBe(false);
    expect(assessPassphrase('aaaaaaaaaaaa').ok).toBe(false);
    expect(assessPassphrase('correct horse battery').ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('vault lifecycle', () => {
  it('starts uninitialised, then unlocks', async () => {
    expect(await vault.status()).toBe('uninitialised');
    await vault.initialise(PASSPHRASE);
    expect(await vault.status()).toBe('unlocked');
  });

  it('refuses a weak passphrase at creation', async () => {
    await expect(vault.initialise('abc')).rejects.toThrow();
    expect(await vault.status()).toBe('uninitialised');
  });

  it('locks and reopens with the right passphrase', async () => {
    await vault.initialise(PASSPHRASE);
    await vault.put({ piiType: 'aadhaar', label: 'mine', value: AADHAAR });

    vault.lock();
    expect(await vault.status()).toBe('locked');
    expect(vault.list()).toEqual([]);

    await vault.unlock(PASSPHRASE);
    expect(vault.list().map((e) => e.label)).toEqual(['mine']);
  });

  it('rejects the wrong passphrase and stays locked', async () => {
    await vault.initialise(PASSPHRASE);
    await vault.put({ piiType: 'aadhaar', label: 'mine', value: AADHAAR });
    vault.lock();

    await expect(vault.unlock('not the passphrase')).rejects.toThrow(VaultAuthError);
    expect(await vault.status()).toBe('locked');
  });

  it('refuses writes while locked', async () => {
    await vault.initialise(PASSPHRASE);
    vault.lock();
    await expect(vault.put({ piiType: 'email', label: 'x', value: 'a@b.com' })).rejects.toThrow(
      VaultLockedError,
    );
  });

  it('destroys everything irreversibly', async () => {
    await vault.initialise(PASSPHRASE);
    await vault.put({ piiType: 'aadhaar', label: 'mine', value: AADHAAR });
    await vault.destroy();

    expect(await vault.status()).toBe('uninitialised');
    expect(JSON.stringify(store.data)).not.toContain(AADHAAR);
  });
});

// ---------------------------------------------------------------------------
// Lifetimes — the load-bearing behaviour
// ---------------------------------------------------------------------------

describe('secret lifetimes', () => {
  it('never writes a persisted value in plaintext', async () => {
    await vault.initialise(PASSPHRASE);
    await vault.put({ piiType: 'aadhaar', label: 'mine', value: AADHAAR });
    expect(JSON.stringify(store.data)).not.toContain(AADHAAR);
  });

  /**
   * The structural guarantee. A one-time code must not reach disk even if a caller
   * asks for it to be stored — a saved OTP is both useless and a bearer token.
   */
  it('never writes an ephemeral secret to storage at all', async () => {
    await vault.initialise(PASSPHRASE);
    await vault.put({ piiType: 'otp', label: 'sms code', value: '483920' });

    // Present in memory...
    expect(vault.list().map((e) => e.piiType)).toContain('otp');
    // ...and absent from disk, in any form.
    expect(JSON.stringify(store.data)).not.toContain('483920');
    expect(JSON.stringify(store.data)).not.toContain('sms code');
  });

  it('drops ephemeral secrets on lock and does not restore them', async () => {
    await vault.initialise(PASSPHRASE);
    await vault.put({ piiType: 'otp', label: 'sms code', value: '483920' });
    await vault.put({ piiType: 'aadhaar', label: 'mine', value: AADHAAR });

    vault.lock();
    await vault.unlock(PASSPHRASE);

    const types = vault.list().map((e) => e.piiType);
    expect(types).toContain('aadhaar');
    expect(types).not.toContain('otp');
  });

  it('consumes a one-time secret exactly once', async () => {
    await vault.initialise(PASSPHRASE);
    const slot = await vault.put({ piiType: 'otp', label: 'code', value: '483920' });

    expect(vault.consumeEphemeral(slot)).toBe('483920');
    expect(vault.consumeEphemeral(slot)).toBeUndefined();
  });

  /**
   * An open side panel must not be a standing login. Reading a session-lifetime
   * value costs the passphrase again.
   */
  it('requires the passphrase to read a session-lifetime value', async () => {
    expect(policyFor('password').lifetime).toBe('session');

    await vault.initialise(PASSPHRASE);
    const slot = await vault.put({ piiType: 'password', label: 'portal', value: 'hunter2!' });

    await expect(vault.reveal(slot)).rejects.toThrow(VaultLockedError);
    await expect(vault.reveal(slot, 'wrong')).rejects.toThrow(VaultAuthError);
    expect(await vault.reveal(slot, PASSPHRASE)).toBe('hunter2!');
  });

  it('reads a persistent value without re-auth', async () => {
    await vault.initialise(PASSPHRASE);
    const slot = await vault.put({ piiType: 'aadhaar', label: 'mine', value: AADHAAR });
    expect(await vault.reveal(slot)).toBe(AADHAAR);
  });
});

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

describe('entries', () => {
  it('lists metadata without values', async () => {
    await vault.initialise(PASSPHRASE);
    await vault.put({ piiType: 'aadhaar', label: 'mine', value: AADHAAR });

    const views = vault.list();
    expect(JSON.stringify(views)).not.toContain(AADHAAR);
    expect(views[0]?.length).toBe(AADHAAR.length);
  });

  it('updates in place when given an existing slot', async () => {
    await vault.initialise(PASSPHRASE);
    const slot = await vault.put({ piiType: 'email', label: 'mine', value: 'a@b.com' });
    await vault.put({ piiType: 'email', label: 'mine', value: 'c@d.com', slot });

    expect(vault.list().length).toBe(1);
    expect(await vault.reveal(slot)).toBe('c@d.com');
  });

  /**
   * Two entries with the same label are a naming problem, not a reason to silently
   * overwrite one of them.
   */
  it('disambiguates rather than overwriting on a duplicate label', async () => {
    await vault.initialise(PASSPHRASE);
    const a = await vault.put({ piiType: 'email', label: 'mine', value: 'a@b.com' });
    const b = await vault.put({ piiType: 'email', label: 'mine', value: 'c@d.com' });

    expect(a).not.toBe(b);
    expect(vault.list().length).toBe(2);
  });

  it('deletes an entry', async () => {
    await vault.initialise(PASSPHRASE);
    const slot = await vault.put({ piiType: 'aadhaar', label: 'mine', value: AADHAAR });
    await vault.remove(slot);

    expect(vault.list()).toEqual([]);
    expect(JSON.stringify(store.data)).not.toContain(AADHAAR);
  });

  it('records origins a value has been used on', async () => {
    await vault.initialise(PASSPHRASE);
    const slot = await vault.put({ piiType: 'aadhaar', label: 'mine', value: AADHAAR });

    await vault.recordUse(slot, 'https://portal.example.edu');
    await vault.recordUse(slot, 'https://portal.example.edu');

    expect(vault.list()[0]?.usedOn).toEqual(['https://portal.example.edu']);
  });

  /**
   * Binding is the security-relevant half of `recordUse`. Once a credential has a
   * site, every later use is checked against it, so this call is what turns "not yet
   * known" into "only ever here".
   */
  it('binds a credential to the first site it is used on', async () => {
    await vault.initialise(PASSPHRASE);
    const slot = await vault.put({
      piiType: 'password',
      label: 'portal',
      value: 'hunter2hunter2',
    });
    expect(vault.list()[0]?.site).toBeUndefined();

    await vault.recordUse(slot, 'https://portal.example.edu');
    expect(vault.list()[0]?.site).toBe('https://portal.example.edu');

    // A later use elsewhere must not move it. The validator refuses first, but the
    // store must not quietly re-home a credential even if it is called directly.
    await vault.recordUse(slot, 'https://portal.exarnple.edu');
    expect(vault.list()[0]?.site).toBe('https://portal.example.edu');
  });

  /** Ordinary profile data is not site-specific: a name is the user's to type anywhere. */
  it('does not bind data that is not a credential', async () => {
    await vault.initialise(PASSPHRASE);
    const slot = await vault.put({ piiType: 'person_name', label: 'me', value: 'Asha Rao' });

    await vault.recordUse(slot, 'https://portal.example.edu');
    expect(vault.list()[0]?.site).toBeUndefined();
  });

  it('keeps the binding when the value is updated', async () => {
    await vault.initialise(PASSPHRASE);
    const slot = await vault.put({
      piiType: 'password',
      label: 'portal',
      value: 'hunter2hunter2',
      site: 'https://portal.example.edu',
    });

    await vault.put({ piiType: 'password', label: 'portal', value: 'newpassword1', slot });
    expect(vault.list()[0]?.site).toBe('https://portal.example.edu');
  });

  /** Only the user may re-home a credential, and `rebind` is the only way to do it. */
  it('lets the user move a credential to another site', async () => {
    await vault.initialise(PASSPHRASE);
    const slot = await vault.put({
      piiType: 'password',
      label: 'portal',
      value: 'hunter2hunter2',
      site: 'https://old.example.edu',
    });

    await vault.rebind(slot, 'https://new.example.edu');
    expect(vault.list()[0]?.site).toBe('https://new.example.edu');

    await vault.rebind(slot, undefined);
    expect(vault.list()[0]?.site).toBeUndefined();
  });

  it('rejects an empty value', async () => {
    await vault.initialise(PASSPHRASE);
    await expect(vault.put({ piiType: 'email', label: 'x', value: '' })).rejects.toThrow();
  });

  /**
   * A value equal to its own type name is a description typed into the value box, and it
   * does active harm rather than nothing: every stored value becomes a literal the
   * redactor searches every page for, so an entry whose text is one of our own
   * identifiers makes the redactor find "secrets" everywhere. Exactly one such entry
   * ended every agent run until it was tracked down.
   */
  it('rejects a value that is just the name of the field', async () => {
    await vault.initialise(PASSPHRASE);
    await expect(
      vault.put({
        piiType: 'registration_number',
        label: 'mine',
        value: 'registration_number',
      }),
    ).rejects.toThrow(/name of the field/i);

    // Separators and case are noise, so the same slip written differently is refused too.
    await expect(
      vault.put({
        piiType: 'registration_number',
        label: 'mine',
        value: 'Registration Number',
      }),
    ).rejects.toThrow(/name of the field/i);
  });

  it('rejects a value that is just the label', async () => {
    await vault.initialise(PASSPHRASE);
    await expect(
      vault.put({ piiType: 'roll_number', label: 'College roll', value: 'college roll' }),
    ).rejects.toThrow(/label/i);
  });

  /** A real value that merely contains a type word is fine. */
  it('accepts a legitimate value containing a field word', async () => {
    await vault.initialise(PASSPHRASE);
    await expect(
      vault.put({ piiType: 'address', label: 'home', value: '12 Registration Road, Pune' }),
    ).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Redaction dictionary
// ---------------------------------------------------------------------------

describe('asRedactionDictionary', () => {
  it('projects every value, including ephemeral ones', async () => {
    await vault.initialise(PASSPHRASE);
    await vault.put({ piiType: 'aadhaar', label: 'mine', value: AADHAAR });
    await vault.put({ piiType: 'otp', label: 'code', value: '483920' });

    const dict = vault.asRedactionDictionary();
    // An OTP on screen still has to be masked before the screenshot leaves, even
    // though it is never written to disk.
    expect(dict.map((d) => d.piiType).sort()).toEqual(['aadhaar', 'otp']);
  });

  /**
   * Detection degrades to patterns and structure rather than failing when locked,
   * which is the right trade for a user who has not unlocked.
   */
  it('is empty while locked', async () => {
    await vault.initialise(PASSPHRASE);
    await vault.put({ piiType: 'aadhaar', label: 'mine', value: AADHAAR });
    vault.lock();
    expect(vault.asRedactionDictionary()).toEqual([]);
  });

  it('finds an entry by its placeholder token', async () => {
    await vault.initialise(PASSPHRASE);
    const slot = await vault.put({ piiType: 'aadhaar', label: 'My Aadhaar', value: AADHAAR });

    const found = vault.findByToken(`AADHAAR_${slot.toUpperCase()}`);
    expect(found?.slot).toBe(slot);
    expect(vault.findByToken('AADHAAR_NOPE')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Device-key mode — the no-passphrase default
// ---------------------------------------------------------------------------

describe('device-key mode', () => {
  /**
   * The whole reason this mode exists: a vault that demands setup stays empty, and
   * an empty vault means the redactor cannot recognise the user's own name. Friction
   * here costs privacy elsewhere.
   */
  it('opens with no input from the user', async () => {
    expect(await vault.openAutomatically()).toBe(true);
    expect(await vault.status()).toBe('unlocked');
    expect(await vault.keyMode()).toBe('device');
  });

  it('survives a lock and reopens automatically', async () => {
    await vault.openAutomatically();
    await vault.put({ piiType: 'person_name', label: 'me', value: 'Ramesh Kumar' });

    vault.lock();
    expect(await vault.status()).toBe('locked');

    expect(await vault.openAutomatically()).toBe(true);
    expect(vault.list().map((e) => e.label)).toEqual(['me']);
  });

  it('still encrypts on disk', async () => {
    await vault.openAutomatically();
    await vault.put({ piiType: 'aadhaar', label: 'mine', value: AADHAAR });
    // The key is stored alongside, so this is not protection against someone who
    // knows where to look — but the value must not be sitting there in plain text.
    expect(JSON.stringify(store.data)).not.toContain(AADHAAR);
  });

  /**
   * Re-auth is meaningless without a passphrase to re-enter, so demanding one would
   * be friction with no security behind it.
   */
  it('reads a session-lifetime value without a passphrase', async () => {
    await vault.openAutomatically();
    const slot = await vault.put({ piiType: 'password', label: 'portal', value: 'hunter2!' });
    expect(await vault.reveal(slot)).toBe('hunter2!');
  });

  it('still refuses to write an ephemeral secret to disk', async () => {
    await vault.openAutomatically();
    await vault.put({ piiType: 'otp', label: 'code', value: '483920' });
    expect(JSON.stringify(store.data)).not.toContain('483920');
  });

  it('will not auto-open a passphrase-protected vault', async () => {
    await vault.initialise(PASSPHRASE);
    vault.lock();
    expect(await vault.openAutomatically()).toBe(false);
    expect(await vault.status()).toBe('locked');
  });
});

describe('switching protection modes', () => {
  it('upgrades to a passphrase and keeps the entries', async () => {
    await vault.openAutomatically();
    await vault.put({ piiType: 'aadhaar', label: 'mine', value: AADHAAR });

    await vault.upgradeToPassphrase(PASSPHRASE);
    expect(await vault.keyMode()).toBe('passphrase');

    vault.lock();
    // The stored device key must be gone, or the passphrase would be decorative.
    expect(await vault.openAutomatically()).toBe(false);

    await vault.unlock(PASSPHRASE);
    expect(vault.list().map((e) => e.label)).toEqual(['mine']);
  });

  it('refuses a weak passphrase on upgrade', async () => {
    await vault.openAutomatically();
    await expect(vault.upgradeToPassphrase('abc')).rejects.toThrow();
    expect(await vault.keyMode()).toBe('device');
  });

  it('downgrades back to a device key', async () => {
    await vault.initialise(PASSPHRASE);
    await vault.put({ piiType: 'email', label: 'mine', value: 'a@b.com' });

    await vault.downgradeToDeviceKey();
    expect(await vault.keyMode()).toBe('device');

    vault.lock();
    expect(await vault.openAutomatically()).toBe(true);
    expect(vault.list().map((e) => e.label)).toEqual(['mine']);
  });

  it('requires the vault open before weakening it', async () => {
    await vault.initialise(PASSPHRASE);
    vault.lock();
    await expect(vault.downgradeToDeviceKey()).rejects.toThrow(VaultLockedError);
  });
});
