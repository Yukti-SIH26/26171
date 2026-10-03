/**
 * Sensitive-data taxonomy and redaction policy.
 *
 * Four independent detectors feed this, all of them always running:
 *  1. `known_value`  - matches the user's own vault entries. Near-certain.
 *  2. `structural`   - `input[type=password]`, `autocomplete=cc-number`, ARIA labels.
 *  3. `pattern`      - format plus checksum (Aadhaar Verhoeff, PAN, IFSC, Luhn).
 *  4. `semantic`     - in-browser NER reading context, catches formats nobody
 *                      wrote a rule for. This is what generalizes to unseen sites.
 *  (+ `vision_face` for faces, which is its own thing.)
 *
 * Confidence is fused by taking the maximum across detectors, then compared
 * against a per-type threshold.
 *
 * The thresholds deliberately run in opposite directions:
 *   - High-stakes types (password, OTP, Aadhaar) get LOW thresholds. A missed
 *     detection leaks data, which is unrecoverable, so we act on weak evidence.
 *   - Low-stakes types (person name) get HIGHER thresholds. Over-redacting
 *     starves the remote model of context and it stops being able to help.
 * That tension is the whole reason redaction precision is scored separately
 * from detection recall.
 */

import type { Rect } from './geometry.ts';
import type { ElementId } from './element.ts';

export type PiiType =
  // Credentials and one-time secrets
  | 'password'
  | 'otp'
  | 'cvv'
  | 'api_key'
  | 'secret_token'
  // Indian government identifiers
  | 'aadhaar'
  | 'pan'
  | 'voter_id'
  | 'passport'
  | 'driving_licence'
  | 'gstin'
  // Financial
  | 'credit_card'
  | 'bank_account'
  | 'ifsc'
  | 'upi_id'
  // Education portal identifiers (our first real target is a college portal)
  | 'roll_number'
  | 'registration_number'
  // Contact and identity
  //
  // `person_name` is the whole name; `given_name` and `family_name` are the parts. All
  // three exist because forms ask for whichever they please, and collapsing them was a
  // real bug: with only `person_name` available the agent had one value and two boxes,
  // so "First Name" and "Last Name" both received the full name.
  | 'person_name'
  | 'given_name'
  | 'family_name'
  | 'address'
  | 'email'
  | 'phone'
  | 'date_of_birth'
  | 'vehicle_number'
  // Visual
  | 'face'
  | 'signature';

export const ALL_PII_TYPES: readonly PiiType[] = [
  'password',
  'otp',
  'cvv',
  'api_key',
  'secret_token',
  'aadhaar',
  'pan',
  'voter_id',
  'passport',
  'driving_licence',
  'gstin',
  'credit_card',
  'bank_account',
  'ifsc',
  'upi_id',
  'roll_number',
  'registration_number',
  'person_name',
  'given_name',
  'family_name',
  'address',
  'email',
  'phone',
  'date_of_birth',
  'vehicle_number',
  'face',
  'signature',
] as const;

export type DetectorId = 'known_value' | 'structural' | 'pattern' | 'semantic' | 'vision_face';

/**
 * How long a secret may be retained.
 *  - `persistent`: safe to keep in the encrypted vault (Aadhaar, name, address).
 *  - `session`:    vault-stored but gated behind re-auth (passwords).
 *  - `ephemeral`:  memory only, wiped immediately after use, never written to
 *                  disk. OTPs and CVVs. A stored OTP is useless and a liability.
 */
export type SecretLifetime = 'persistent' | 'session' | 'ephemeral';

export type RedactionMode =
  /** Opaque rectangle over the pixels. Unrecoverable. */
  | 'mask_solid'
  /** Gaussian blur. Partially reversible by deep models, so faces only. */
  | 'blur'
  /** Replace text with a stable token like `AADHAAR_1`. */
  | 'placeholder'
  /** Replace with a fake value of the same shape, so layout logic still works. */
  | 'synthetic'
  /** Remove the field from the payload entirely. */
  | 'drop'
  | 'none';

export interface PiiDetection {
  readonly id: string;
  readonly piiType: PiiType;
  readonly detector: DetectorId;
  /** 0..1 */
  readonly confidence: number;
  readonly elementId?: ElementId;
  /** Pixel-space region, required for screenshot redaction. */
  readonly rect?: Rect;
  /** Character span within the element's text, for surgical text redaction. */
  readonly span?: { readonly start: number; readonly end: number };
  /**
   * The literal matched text.
   *
   * NEVER leaves the device. Held only so the redactor can find and replace it
   * and so the leak-canary suite can assert its absence from outbound bytes.
   * The privacy firewall strips this field unconditionally.
   */
  readonly matchedText?: string;
}

export interface PiiPolicy {
  readonly piiType: PiiType;
  readonly lifetime: SecretLifetime;
  readonly redaction: RedactionMode;
  /** Fused confidence at or above which we redact. */
  readonly threshold: number;
  /** Blur is partially reversible; forbid it for anything high-value. */
  readonly neverBlur: boolean;
  /**
   * This value is site-specific: it belongs to one origin and must be refused on
   * every other, which is what a look-alike phishing page runs into.
   *
   * False for things a person legitimately types anywhere — their own name, a
   * postcode, an IFSC code.
   */
  readonly confirmBeforeUse: boolean;
}

function policy(
  piiType: PiiType,
  lifetime: SecretLifetime,
  redaction: RedactionMode,
  threshold: number,
  neverBlur: boolean,
  confirmBeforeUse: boolean,
): PiiPolicy {
  return { piiType, lifetime, redaction, threshold, neverBlur, confirmBeforeUse };
}

/**
 * Default policy table.
 *
 * Note the threshold gradient: 0.2 for a password (act on almost any hint)
 * versus 0.75 for a person's name (demand real evidence, because blacking out
 * every capitalised word destroys the page for the remote model).
 */
export const DEFAULT_PII_POLICIES: Readonly<Record<PiiType, PiiPolicy>> = {
  // Credentials: maximum aggression, solid masking only.
  password: policy('password', 'session', 'mask_solid', 0.2, true, true),
  otp: policy('otp', 'ephemeral', 'mask_solid', 0.2, true, true),
  cvv: policy('cvv', 'ephemeral', 'mask_solid', 0.2, true, true),
  api_key: policy('api_key', 'session', 'mask_solid', 0.3, true, true),
  secret_token: policy('secret_token', 'session', 'mask_solid', 0.3, true, true),

  // Government IDs: placeholder keeps structure so the model can still reason
  // ("an Aadhaar belongs in this field") without seeing the digits.
  aadhaar: policy('aadhaar', 'persistent', 'placeholder', 0.35, true, true),
  pan: policy('pan', 'persistent', 'placeholder', 0.35, true, true),
  voter_id: policy('voter_id', 'persistent', 'placeholder', 0.4, true, true),
  passport: policy('passport', 'persistent', 'placeholder', 0.4, true, true),
  driving_licence: policy('driving_licence', 'persistent', 'placeholder', 0.4, true, true),
  gstin: policy('gstin', 'persistent', 'placeholder', 0.45, true, false),

  // Financial
  credit_card: policy('credit_card', 'session', 'placeholder', 0.3, true, true),
  bank_account: policy('bank_account', 'persistent', 'placeholder', 0.35, true, true),
  ifsc: policy('ifsc', 'persistent', 'placeholder', 0.5, false, false),
  upi_id: policy('upi_id', 'persistent', 'placeholder', 0.45, true, true),

  // Education identifiers: needed to complete portal tasks, so synthetic
  // substitution preserves shape without revealing the real value.
  roll_number: policy('roll_number', 'persistent', 'synthetic', 0.5, false, false),
  registration_number: policy(
    'registration_number',
    'persistent',
    'synthetic',
    0.5,
    false,
    false,
  ),

  // Contact and identity: higher thresholds to protect against over-redaction.
  person_name: policy('person_name', 'persistent', 'synthetic', 0.75, false, false),
  // The parts carry the same policy as the whole. A given name on its own is weaker
  // evidence of identity, but it is still the user's name, and a threshold that let one
  // through while masking the other would produce a screenshot with half a name in it.
  given_name: policy('given_name', 'persistent', 'synthetic', 0.75, false, false),
  family_name: policy('family_name', 'persistent', 'synthetic', 0.75, false, false),
  address: policy('address', 'persistent', 'synthetic', 0.7, false, false),
  email: policy('email', 'persistent', 'placeholder', 0.6, false, false),
  phone: policy('phone', 'persistent', 'placeholder', 0.55, false, false),
  date_of_birth: policy('date_of_birth', 'persistent', 'synthetic', 0.6, false, false),
  // Identifies a person's vehicle as directly as a phone number identifies their
  // phone, and a transport or hostel page will display one.
  vehicle_number: policy('vehicle_number', 'persistent', 'placeholder', 0.6, false, false),

  // Visual: blur is acceptable for a face (goal is "not identifiable at a
  // glance"), never for text.
  face: policy('face', 'persistent', 'blur', 0.5, false, false),
  signature: policy('signature', 'persistent', 'mask_solid', 0.5, true, false),
};

export function policyFor(piiType: PiiType): PiiPolicy {
  return DEFAULT_PII_POLICIES[piiType];
}

/** Fuse detectors by taking the strongest signal for each PII type. */
export function fuseConfidence(detections: readonly PiiDetection[]): number {
  let max = 0;
  for (const d of detections) {
    if (d.confidence > max) max = d.confidence;
  }
  return max;
}

export function shouldRedact(
  piiType: PiiType,
  fusedConfidence: number,
  policies: Readonly<Record<PiiType, PiiPolicy>> = DEFAULT_PII_POLICIES,
): boolean {
  return fusedConfidence >= policies[piiType].threshold;
}

/**
 * Resolve the redaction mode, refusing blur for anything flagged `neverBlur`.
 *
 * This exists because blur looks like redaction but is partially reversible on
 * text with known structure. Making it a hard type-level rule means a future
 * contributor cannot quietly blur a password field.
 */
export function resolveRedactionMode(
  piiType: PiiType,
  requested?: RedactionMode,
  policies: Readonly<Record<PiiType, PiiPolicy>> = DEFAULT_PII_POLICIES,
): RedactionMode {
  const p = policies[piiType];
  if (requested === undefined) return p.redaction;
  if (requested === 'blur' && p.neverBlur) return 'mask_solid';
  return requested;
}

export function isEphemeral(piiType: PiiType): boolean {
  return DEFAULT_PII_POLICIES[piiType].lifetime === 'ephemeral';
}

/** Types that must never be written to disk, even encrypted. */
export function ephemeralTypes(): PiiType[] {
  return ALL_PII_TYPES.filter(isEphemeral);
}
