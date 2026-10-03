import { describe, expect, it } from 'vitest';
import {
  ALL_PII_TYPES,
  DEFAULT_PII_POLICIES,
  ephemeralTypes,
  fuseConfidence,
  isEphemeral,
  policyFor,
  resolveRedactionMode,
  shouldRedact,
  type PiiDetection,
  type PiiType,
} from '../src/pii.ts';

function detection(
  piiType: PiiType,
  detector: PiiDetection['detector'],
  confidence: number,
): PiiDetection {
  return { id: `${detector}:${piiType}`, piiType, detector, confidence };
}

describe('policy table completeness', () => {
  it('has a policy for every declared PII type', () => {
    for (const t of ALL_PII_TYPES) {
      expect(DEFAULT_PII_POLICIES[t], `missing policy for ${t}`).toBeDefined();
      expect(policyFor(t).piiType).toBe(t);
    }
  });

  it('declares no policies for undeclared types', () => {
    expect(Object.keys(DEFAULT_PII_POLICIES).sort()).toEqual([...ALL_PII_TYPES].sort());
  });

  it('keeps every threshold inside 0..1', () => {
    for (const t of ALL_PII_TYPES) {
      const { threshold } = policyFor(t);
      expect(threshold).toBeGreaterThan(0);
      expect(threshold).toBeLessThanOrEqual(1);
    }
  });
});

describe('blur is refused for high-value data', () => {
  // Blur and pixelation are partially reversible on text with known structure,
  // so they are unacceptable for anything a leak would be catastrophic for.
  it('downgrades a blur request to a solid mask for credentials', () => {
    expect(resolveRedactionMode('password', 'blur')).toBe('mask_solid');
    expect(resolveRedactionMode('otp', 'blur')).toBe('mask_solid');
    expect(resolveRedactionMode('cvv', 'blur')).toBe('mask_solid');
    expect(resolveRedactionMode('aadhaar', 'blur')).toBe('mask_solid');
    expect(resolveRedactionMode('credit_card', 'blur')).toBe('mask_solid');
  });

  it('permits blur for faces, where the goal is only unrecognisability', () => {
    expect(resolveRedactionMode('face', 'blur')).toBe('blur');
  });

  it('never resolves to blur for any neverBlur type, whatever is requested', () => {
    for (const t of ALL_PII_TYPES) {
      if (!policyFor(t).neverBlur) continue;
      expect(resolveRedactionMode(t, 'blur'), `${t} must not blur`).not.toBe('blur');
    }
  });

  it('falls back to the policy default when nothing is requested', () => {
    expect(resolveRedactionMode('person_name')).toBe('synthetic');
    expect(resolveRedactionMode('password')).toBe('mask_solid');
    expect(resolveRedactionMode('aadhaar')).toBe('placeholder');
  });
});

describe('threshold gradient', () => {
  // The scoring criteria pull against each other: recall on sensitive data
  // versus precision of redaction. The gradient is how that tension is resolved.
  it('is far more eager to redact credentials than names', () => {
    expect(policyFor('password').threshold).toBeLessThan(policyFor('person_name').threshold);
    expect(policyFor('otp').threshold).toBeLessThan(policyFor('person_name').threshold);
  });

  it('is more eager on government IDs than on contact details', () => {
    expect(policyFor('aadhaar').threshold).toBeLessThan(policyFor('email').threshold);
    expect(policyFor('pan').threshold).toBeLessThan(policyFor('phone').threshold);
  });

  it('acts on a single weak credential hint but not a weak name hint', () => {
    expect(shouldRedact('password', 0.25)).toBe(true);
    expect(shouldRedact('person_name', 0.25)).toBe(false);
  });
});

describe('confidence fusion', () => {
  it('is 0 with no detections', () => {
    expect(fuseConfidence([])).toBe(0);
  });

  it('takes the strongest detector', () => {
    const fused = fuseConfidence([
      detection('aadhaar', 'semantic', 0.42),
      detection('aadhaar', 'pattern', 0.88),
      detection('aadhaar', 'structural', 0.3),
    ]);
    expect(fused).toBe(0.88);
  });

  it('lets a single certain detector carry a weak field over the line', () => {
    // A bare 12-digit number with no label: the semantic model is unsure, but
    // an exact vault match settles it.
    const weak = [detection('aadhaar', 'semantic', 0.2)];
    expect(shouldRedact('aadhaar', fuseConfidence(weak))).toBe(false);

    const withVaultHit = [...weak, detection('aadhaar', 'known_value', 0.99)];
    expect(shouldRedact('aadhaar', fuseConfidence(withVaultHit))).toBe(true);
  });
});

describe('secret lifetimes', () => {
  it('marks one-time secrets ephemeral', () => {
    expect(isEphemeral('otp')).toBe(true);
    expect(isEphemeral('cvv')).toBe(true);
  });

  it('does not mark durable identifiers ephemeral', () => {
    expect(isEphemeral('aadhaar')).toBe(false);
    expect(isEphemeral('person_name')).toBe(false);
  });

  it('reports exactly the types that must never touch disk', () => {
    expect(ephemeralTypes().sort()).toEqual(['cvv', 'otp']);
  });

  it('never marks an ephemeral type as persistent', () => {
    for (const t of ephemeralTypes()) {
      expect(policyFor(t).lifetime).toBe('ephemeral');
    }
  });
});

describe('use confirmation', () => {
  it('requires confirmation before typing credentials or IDs on a new origin', () => {
    for (const t of ['password', 'otp', 'aadhaar', 'pan', 'credit_card'] as const) {
      expect(policyFor(t).confirmBeforeUse, `${t} should need confirmation`).toBe(true);
    }
  });

  it('does not gate low-risk fields behind a prompt', () => {
    for (const t of ['person_name', 'email', 'roll_number'] as const) {
      expect(policyFor(t).confirmBeforeUse, `${t} should not need confirmation`).toBe(false);
    }
  });
});
