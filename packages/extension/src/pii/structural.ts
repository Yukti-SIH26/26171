/**
 * Structural detector — layer 2 of four.
 *
 * Classifies a field by what the markup *declares about itself*, before looking
 * at any value. `input[type=password]` is a password field with certainty; an
 * `autocomplete="cc-number"` attribute is the page telling us, in a standardised
 * vocabulary, that a card number goes here.
 *
 * This layer is valuable for a reason the pattern layer cannot match: it fires on
 * *empty* fields. A login form the agent is about to fill has no value to pattern
 * match yet, but we still need to know that the second box is a password before
 * the agent types into it — and before a screenshot of it leaves the machine.
 *
 * It is also the layer that catches the bait-field attack, where a page labels a
 * box "Search" but marks it `autocomplete="cc-number"`. Attribute and label
 * disagreeing is itself a signal, so the two are scored separately rather than
 * collapsed.
 *
 * Deliberately not site-specific. Everything read here is part of the HTML and
 * ARIA standards, which is what makes it generalize across sites rather than
 * being a per-site rule.
 */

import type { ElementNode, PiiType } from '@sih/core';

export interface StructuralFinding {
  readonly piiType: PiiType;
  readonly confidence: number;
  /** Which attribute or text produced the classification, for the audit trail. */
  readonly evidence: string;
}

/**
 * The HTML autocomplete vocabulary.
 *
 * Near-certain when present: a page has no incentive to mislabel these, because
 * browsers and password managers act on them.
 */
const AUTOCOMPLETE_MAP: Readonly<Record<string, PiiType>> = {
  'current-password': 'password',
  'new-password': 'password',
  'one-time-code': 'otp',
  'cc-number': 'credit_card',
  'cc-csc': 'cvv',
  'cc-name': 'person_name',
  'cc-exp': 'credit_card',
  'cc-exp-year': 'credit_card',
  'cc-exp-month': 'credit_card',
  name: 'person_name',
  // Mapped to their own types rather than all collapsing to `person_name`. When they
  // collapsed, a form with First Name and Last Name boxes offered the agent one token
  // for both, and it dutifully typed the full name into each.
  'given-name': 'given_name',
  'family-name': 'family_name',
  'additional-name': 'given_name',
  email: 'email',
  username: 'person_name',
  tel: 'phone',
  'tel-national': 'phone',
  bday: 'date_of_birth',
  'bday-day': 'date_of_birth',
  'bday-month': 'date_of_birth',
  'bday-year': 'date_of_birth',
  'street-address': 'address',
  'address-line1': 'address',
  'address-line2': 'address',
  'address-level1': 'address',
  'address-level2': 'address',
  'postal-code': 'address',
};

/**
 * Label and name keywords.
 *
 * Weaker evidence than `autocomplete`, because a label is written for humans and
 * can be anything. Ordered most specific first: "confirm password" must not be
 * read as a generic name field just because it contains no autocomplete hint.
 */
const LABEL_RULES: readonly {
  readonly piiType: PiiType;
  readonly pattern: RegExp;
  readonly confidence: number;
}[] = [
  {
    piiType: 'api_key',
    pattern:
      /\b(?:api|access|secret|client|developer|subscription|signing)[\s_-]*(?:key|secret)\b|\bclient[\s_-]*id\b/i,
    confidence: 0.9,
  },
  {
    piiType: 'secret_token',
    pattern:
      /\b(?:access|refresh|auth(?:entication|orization)?|bearer|session|personal[\s_-]*access|webhook|csrf)[\s_-]*(?:token|secret|cookie|key)?\b|\b(?:private[\s_-]*key|token|session[\s_-]*id|cookie)\b/i,
    confidence: 0.9,
  },
  { piiType: 'password', pattern: /\b(?:pass\s?word|passwd|pwd|pin)\b/i, confidence: 0.8 },
  {
    piiType: 'otp',
    pattern: /\b(?:otp|one[\s-]?time|verification\s*code|passcode)\b/i,
    confidence: 0.8,
  },
  { piiType: 'cvv', pattern: /\b(?:cvv|cvc|csc|security\s*code)\b/i, confidence: 0.8 },
  { piiType: 'aadhaar', pattern: /\b(?:aadhaar|aadhar|uid(?:ai)?)\b/i, confidence: 0.75 },
  { piiType: 'pan', pattern: /\b(?:pan(?:\s*card)?|permanent\s*account)\b/i, confidence: 0.7 },
  { piiType: 'passport', pattern: /\bpassport\b/i, confidence: 0.7 },
  {
    piiType: 'driving_licence',
    pattern: /\b(?:driving|driver'?s)\s*licen[cs]e\b/i,
    confidence: 0.7,
  },
  { piiType: 'voter_id', pattern: /\b(?:voter|epic)\s*(?:id|card|no)\b/i, confidence: 0.7 },
  { piiType: 'gstin', pattern: /\bgst(?:in)?\b/i, confidence: 0.7 },
  {
    piiType: 'credit_card',
    pattern: /\b(?:card\s*(?:no|number)|debit|credit\s*card)\b/i,
    confidence: 0.75,
  },
  {
    piiType: 'bank_account',
    pattern: /\b(?:a\/c|account)\s*(?:no|number)\b/i,
    confidence: 0.7,
  },
  { piiType: 'ifsc', pattern: /\bifsc\b/i, confidence: 0.75 },
  { piiType: 'upi_id', pattern: /\b(?:upi|vpa)\b/i, confidence: 0.7 },
  {
    piiType: 'roll_number',
    pattern: /\b(?:roll\s*(?:no|number)?|usn|prn)\b/i,
    confidence: 0.7,
  },
  {
    piiType: 'registration_number',
    pattern: /\b(?:regd?|registration|admission|enrol(?:l)?ment)\s*(?:no|number|id)\b/i,
    confidence: 0.7,
  },
  {
    piiType: 'date_of_birth',
    pattern: /\b(?:d\.?o\.?b|date\s*of\s*birth)\b/i,
    confidence: 0.75,
  },
  {
    piiType: 'vehicle_number',
    pattern: /\b(?:vehicle|registration\s*plate|number\s*plate)\b/i,
    confidence: 0.7,
  },
  {
    piiType: 'address',
    // Above the 0.7 threshold for `address`, because at 0.6 a field explicitly labelled
    // "Permanent Address" was detected and then discarded for want of confidence, and
    // the address went out in the clear.
    pattern:
      /\b(?:address|street|locality|city|town|district|state|pin\s*code|pincode|postal|zip)\b/i,
    confidence: 0.78,
  },
  { piiType: 'email', pattern: /\b(?:e-?mail)\b/i, confidence: 0.7 },
  {
    piiType: 'phone',
    pattern: /\b(?:phone|mobile|contact\s*(?:no|number)|tel|whatsapp)\b/i,
    confidence: 0.75,
  },
  // The name parts come before the whole-name rule, because this list is evaluated
  // most-specific-first and "First Name" matches both. Distinguishing them is what stops
  // a First/Last pair receiving the same full name twice.
  {
    piiType: 'given_name',
    pattern: /\b(?:first|given|fore)\s*name\b/i,
    confidence: 0.8,
  },
  {
    piiType: 'family_name',
    pattern: /\b(?:last|family|sur)\s*name\b|\bsurname\b/i,
    confidence: 0.8,
  },
  {
    piiType: 'person_name',
    // A person's name went out unmasked because the old pattern only knew "full name"
    // and a few relative forms. Confidence is above `person_name`'s 0.75 threshold
    // because an explicit name label is not a guess — the page is telling us what the
    // field holds.
    pattern:
      /\b(?:(?:middle|full|your|student|applicant|candidate|holder|father'?s?|mother'?s?|guardian'?s?|spouse'?s?)\s*name|name\s*(?:of\s*(?:the\s*)?(?:applicant|student|candidate|holder))?)\b/i,
    confidence: 0.8,
  },
];

/** `input[type]` values that are themselves a declaration of sensitivity. */
const INPUT_TYPE_MAP: Readonly<Record<string, PiiType>> = {
  password: 'password',
  email: 'email',
  tel: 'phone',
};

/**
 * Break a programmer identifier into words.
 *
 * Required, not cosmetic. Attribute names are written as `txtAadharNo`,
 * `pan_number`, `ddlState` — and the keyword rules below are anchored on `\b`,
 * which never matches inside a camelCase run. Without this split, the single most
 * literal signal about a field's contents is invisible to every rule.
 *
 *   txtAadharNo  ->  txt Aadhar No
 *   pan_number   ->  pan number
 *   DOBField     ->  DOB Field
 */
function splitIdentifier(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  return (
    value
      // Separators become spaces.
      .replace(/[_\-.[\]]+/g, ' ')
      // lower-to-upper transition: `txtAadhar` -> `txt Aadhar`
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      // Acronym followed by a word: `DOBField` -> `DOB Field`
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      // letter-to-digit transition: `aadhaar12` -> `aadhaar 12`
      .replace(/([A-Za-z])(\d)/g, '$1 $2')
      .trim()
  );
}

/**
 * Classify one element.
 *
 * Returns every independent signal rather than a single verdict, because
 * agreement between layers is itself information: two detectors reaching the same
 * conclusion is stronger than one, and two reaching *different* conclusions on
 * the same field is a red flag worth surfacing.
 */
export function classifyElement(node: ElementNode): StructuralFinding[] {
  const out: StructuralFinding[] = [];

  // ---- input[type] ------------------------------------------------------
  // The strongest signal available, and unambiguous: a browser will mask this
  // field and refuse to autofill it from the wrong source.
  const inputType = node.inputType?.toLowerCase();
  if (inputType !== undefined) {
    const mapped = INPUT_TYPE_MAP[inputType];
    if (mapped !== undefined) {
      out.push({
        piiType: mapped,
        confidence: inputType === 'password' ? 0.99 : 0.7,
        evidence: `input[type=${inputType}]`,
      });
    }
  }

  // ---- autocomplete -----------------------------------------------------
  // A standardised vocabulary the page fills in for the browser's benefit, so it
  // is reliable even when the visible label is misleading.
  const autocomplete = node.autocomplete?.toLowerCase().trim();
  if (autocomplete !== undefined && autocomplete !== '' && autocomplete !== 'off') {
    // Values may carry section/billing/shipping prefixes; the meaning is in the
    // final token.
    const tokens = autocomplete.split(/\s+/);
    const last = tokens[tokens.length - 1];
    const mapped = last === undefined ? undefined : AUTOCOMPLETE_MAP[last];
    if (mapped !== undefined) {
      out.push({
        piiType: mapped,
        confidence: 0.9,
        evidence: `autocomplete=${last ?? ''}`,
      });
    }
  }

  // ---- accessible name, label, placeholder, and attribute names ---------
  // Weakest of the three, and scored that way. Included because a great many
  // real fields carry no autocomplete attribute at all.
  // `node.name` is the computed accessible name, so it already folds in
  // aria-label, aria-labelledby, and the associated <label>.
  const haystack = [node.name, node.placeholder, splitIdentifier(node.fieldName)]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .join(' ');

  if (haystack !== '') {
    for (const rule of LABEL_RULES) {
      if (rule.pattern.test(haystack)) {
        out.push({
          piiType: rule.piiType,
          confidence: rule.confidence,
          evidence: `label:"${haystack.slice(0, 40)}"`,
        });
        // One label signal per element. A label matching several rules means the
        // rules are ambiguous, not that the evidence is stronger.
        break;
      }
    }
  }

  return out;
}

/**
 * Fields the markup declares sensitive but which hold no value yet.
 *
 * Reported separately because they matter for a different reason: nothing needs
 * redacting, but the agent must not type the wrong secret into them, and the
 * executor needs to know before it acts.
 */
export function declaredSensitiveFields(
  nodes: readonly ElementNode[],
): { readonly node: ElementNode; readonly findings: StructuralFinding[] }[] {
  const out: { node: ElementNode; findings: StructuralFinding[] }[] = [];
  for (const node of nodes) {
    if (!node.flags.editable) continue;
    const findings = classifyElement(node);
    if (findings.length > 0) out.push({ node, findings });
  }
  return out;
}

/**
 * Do the attribute-level and label-level signals disagree?
 *
 * A box labelled "Search" but marked `autocomplete="cc-number"` is either a
 * broken page or a deliberate trap for an automated agent. Either way the agent
 * should not type a card number into it, so the disagreement is surfaced rather
 * than silently resolved in favour of the higher-confidence signal.
 */
export function hasConflictingSignals(findings: readonly StructuralFinding[]): boolean {
  const fromAttributes = new Set(
    findings.filter((f) => !f.evidence.startsWith('label:')).map((f) => f.piiType),
  );
  const fromLabels = new Set(
    findings.filter((f) => f.evidence.startsWith('label:')).map((f) => f.piiType),
  );
  if (fromAttributes.size === 0 || fromLabels.size === 0) return false;
  return ![...fromLabels].some((t) => fromAttributes.has(t));
}
