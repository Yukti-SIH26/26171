import { describe, expect, it } from 'vitest';

import {
  isPersistable,
  siteVerdict,
  slotToken,
  summarise,
  type VaultEntry,
} from '../src/vault.ts';

/**
 * Site binding is the anti-phishing rule, so it gets tested as a rule rather than as
 * a behaviour of the UI that happens to call it.
 *
 * It replaced a confirmation dialog on purpose. Asking "use your portal password on
 * this site?" puts the decision on the person least equipped to spot a homograph
 * domain, and in practice trains them to click through. A bound credential simply
 * does not travel off its own origin, and nothing in the UI can waive that.
 */

const ORIGIN = 'https://portal.example.edu';

function entry(partial: Partial<VaultEntry> = {}): VaultEntry {
  return {
    slot: 'portal',
    piiType: 'password',
    label: 'Portal login',
    value: 'hunter2hunter2',
    createdAt: 0,
    updatedAt: 0,
    usedOn: [],
    ...partial,
  };
}

describe('siteVerdict', () => {
  it('claims an unbound credential for the site it is first used on', () => {
    expect(siteVerdict(entry(), ORIGIN)).toBe('bind');
  });

  it('uses a bound credential on its own site', () => {
    expect(siteVerdict(entry({ site: ORIGIN }), ORIGIN)).toBe('use');
  });

  /**
   * The case the rule exists for. `exarnple` with an r-n is the classic look-alike,
   * and it is refused on a string comparison rather than a judgement call.
   */
  it('refuses a bound credential anywhere else', () => {
    expect(siteVerdict(entry({ site: ORIGIN }), 'https://portal.exarnple.edu')).toBe('refuse');
  });

  /** A subdomain is a different origin, and for a credential that is the safe read. */
  it('treats a different subdomain as a different site', () => {
    expect(siteVerdict(entry({ site: ORIGIN }), 'https://login.portal.example.edu')).toBe(
      'refuse',
    );
  });

  /** Scheme is part of the origin, so an https credential does not fall back to http. */
  it('treats http and https as different sites', () => {
    expect(siteVerdict(entry({ site: ORIGIN }), 'http://portal.example.edu')).toBe('refuse');
  });

  /**
   * Profile data is not site-specific. A person types their own name wherever they
   * like, and refusing it would break ordinary form filling for no gain.
   */
  it('lets non-credential data be used anywhere', () => {
    for (const piiType of ['person_name', 'email', 'roll_number', 'ifsc'] as const) {
      expect(siteVerdict(entry({ piiType, site: ORIGIN }), 'https://anywhere.test')).toBe(
        'use',
      );
    }
  });

  /** An empty string is not a binding — it is a missing one. */
  it('treats an empty site as unbound', () => {
    expect(siteVerdict(entry({ site: '' }), ORIGIN)).toBe('bind');
  });
});

describe('slotToken', () => {
  /** Type-revealing and value-hiding: the model needs the kind, never the digits. */
  it('names the type and the slot, and nothing else', () => {
    expect(slotToken('aadhaar', 'primary')).toBe('AADHAAR_PRIMARY');
    expect(slotToken('password', 'portal')).toBe('PASSWORD_PORTAL');
  });
});

describe('isPersistable', () => {
  it('refuses one-time secrets', () => {
    expect(isPersistable('otp')).toBe(false);
    expect(isPersistable('cvv')).toBe(false);
  });

  it('allows everything with a longer life', () => {
    expect(isPersistable('password')).toBe(true);
    expect(isPersistable('aadhaar')).toBe(true);
  });
});

describe('summarise', () => {
  it('counts by lifetime without touching a value', () => {
    const summary = summarise(
      [
        entry({ slot: 'a', piiType: 'password' }),
        entry({ slot: 'b', piiType: 'aadhaar' }),
        entry({ slot: 'c', piiType: 'otp' }),
      ],
      'unlocked',
    );

    expect(summary.entryCount).toBe(3);
    expect(summary.sessionCount).toBe(1);
    expect(summary.persistentCount).toBe(1);
    expect(summary.ephemeralCount).toBe(1);
    expect(JSON.stringify(summary)).not.toContain('hunter2');
  });
});
