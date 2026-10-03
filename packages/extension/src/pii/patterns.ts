/**
 * Pattern detector — layer 3 of four.
 *
 * Finds sensitive values by shape, then confirms them with a checksum wherever
 * one exists. The checksum is the whole point: `\d{12}` matches an Aadhaar
 * number, but on a student portal it also matches order ids, transaction
 * references, and timestamps. Verhoeff turns that into a one-in-ten filter, and
 * that is the difference between a readable redacted page and a black rectangle.
 *
 * Confidence is assigned per rule, not per match, and reflects how much the
 * *shape alone* tells us:
 *   0.95+  checksum-validated and highly constrained (GSTIN, Aadhaar, card)
 *   0.8    strong unambiguous format (email, UPI)
 *   0.5-0.7 shape-only, needs the structural or semantic layer to agree
 *
 * Nothing here decides whether to redact. It reports evidence; `policyFor` and
 * the fused threshold make the call.
 */

import {
  isAadhaar,
  isGstin,
  isIfsc,
  isIndianMobile,
  isPan,
  isPassport,
  isPaymentCard,
  isVehicleNumber,
  type PiiType,
} from '@sih/core';

export interface PatternMatch {
  readonly piiType: PiiType;
  readonly confidence: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface Rule {
  readonly piiType: PiiType;
  readonly pattern: RegExp;
  /** Confidence when the match passes `validate` (or has no validator). */
  readonly confidence: number;
  /** Structural check beyond the regex. A false result discards the match. */
  readonly validate?: (value: string) => boolean;
  /**
   * When set, the match only counts if this appears in the surrounding text.
   *
   * Used for identifiers with no self-describing format. A bare 8-digit number
   * is nothing; an 8-digit number next to the word "roll no" is a roll number.
   */
  readonly requiresContext?: RegExp;
}

/** How far either side of a match we look for a context keyword. */
const CONTEXT_WINDOW = 48;

/**
 * Context-labelled secrets rarely have a stable vendor prefix. Require enough
 * length, character variety, and entropy to avoid treating ordinary UI copy or
 * asset names as credentials while still catching opaque API keys and tokens.
 */
function looksLikeContextualSecret(value: string): boolean {
  const compact = value.trim();
  if (compact.length < 16 || compact.length > 512) return false;
  if (/^(?:[A-Z]+_)*(?:LOCAL|HIDDEN)(?:_[A-Z]+)*$/i.test(compact)) return false;
  if (/^(?:https?:\/\/|www\.)/i.test(compact)) return false;
  if (/\.(?:js|css|png|jpe?g|svg|webp|woff2?)(?:\?|$)/i.test(compact)) return false;

  const classes = [
    /[a-z]/.test(compact),
    /[A-Z]/.test(compact),
    /\d/.test(compact),
    /[^A-Za-z0-9]/.test(compact),
  ].filter(Boolean).length;
  if (classes < 2) return false;

  const counts = new Map<string, number>();
  for (const char of compact) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / compact.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 3.2;
}

/** A portal identifier must contain a digit; labels such as “Registration Number” do not. */
function looksLikePortalIdentifier(value: string): boolean {
  return /\d/.test(value);
}

/**
 * Rules in priority order.
 *
 * Order matters for overlap resolution: the most constrained identifiers come
 * first so that, for example, a GSTIN is not reported as the PAN embedded inside
 * it, and a card number is not reported as a shorter digit run.
 */
const RULES: readonly Rule[] = [
  // ---- Checksum-validated, highly constrained ---------------------------
  {
    piiType: 'gstin',
    pattern: /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z0-9]\b/gi,
    confidence: 0.97,
    validate: isGstin,
  },
  {
    piiType: 'aadhaar',
    // Grouped 4-4-4 is how Aadhaar is printed, so spaces and hyphens are
    // expected rather than exceptional.
    pattern: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    confidence: 0.96,
    validate: isAadhaar,
  },
  {
    piiType: 'credit_card',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    confidence: 0.95,
    validate: isPaymentCard,
  },
  {
    piiType: 'pan',
    pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/gi,
    confidence: 0.94,
    validate: isPan,
  },
  {
    piiType: 'passport',
    pattern: /\b[A-PR-WY][1-9]\d{6}\b/gi,
    confidence: 0.88,
    validate: isPassport,
  },
  {
    piiType: 'ifsc',
    pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi,
    confidence: 0.9,
    validate: isIfsc,
  },

  // ---- Strong self-describing formats -----------------------------------
  {
    piiType: 'email',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    confidence: 0.92,
  },
  {
    piiType: 'upi_id',
    // Distinguished from email by the absence of a dot in the handle part,
    // which is how UPI handles (@okhdfcbank, @paytm) are formed.
    pattern: /\b[A-Z0-9._-]{2,}@(?:ok[a-z]+|paytm|ybl|axl|upi|apl|ibl|sbi|hdfcbank|icici)\b/gi,
    confidence: 0.9,
  },
  {
    piiType: 'phone',
    pattern: /(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g,
    confidence: 0.82,
    validate: isIndianMobile,
  },
  {
    piiType: 'voter_id',
    pattern: /\b[A-Z]{3}\d{7}\b/g,
    confidence: 0.7,
  },
  {
    piiType: 'driving_licence',
    // e.g. MH1420110012345 — state, RTO, year, serial.
    pattern: /\b[A-Z]{2}[\s-]?\d{2}[\s-]?(?:19|20)\d{2}[\s-]?\d{7}\b/gi,
    confidence: 0.85,
  },

  // ---- High-entropy secrets ---------------------------------------------
  {
    piiType: 'api_key',
    // High-confidence provider prefixes used by major AI, cloud, source-control,
    // package, messaging, commerce, and developer platforms. Prefix rules stay
    // separate from the contextual entropy rule below so known formats are masked
    // even when the page gives them no useful label.
    pattern:
      /\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:(?:or-v1|ant-(?:api\d{2})?|proj|svcacct)-)?[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|(?:shpat|shpca|shppa|shpss)_[A-Fa-f0-9]{20,}|(?:dop|doo|dor)_v1_[A-Fa-f0-9]{32,}|lin_api_[A-Za-z0-9]{20,}|(?:secret|ntn)_[A-Za-z0-9]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|SK[0-9A-Fa-f]{32})\b/g,
    confidence: 0.97,
  },
  {
    piiType: 'secret_token',
    // JWTs, authorization headers, credential-bearing connection strings, and
    // complete private-key blocks. Multi-line blocks intentionally match as one
    // finding so the entire rendered element is covered rather than only its header.
    pattern:
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}\b|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+|-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]{16,}?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/gi,
    confidence: 0.97,
  },
  {
    piiType: 'api_key',
    pattern: /\b[A-Za-z0-9][A-Za-z0-9._~+/=-]{15,511}\b/g,
    confidence: 0.88,
    validate: looksLikeContextualSecret,
    requiresContext:
      /\b(?:api|access|secret|client|developer|subscription|signing)[\s_-]*(?:key|secret)\b|\bclient[\s_-]*id\b/i,
  },
  {
    piiType: 'secret_token',
    pattern: /\b[A-Za-z0-9][A-Za-z0-9._~+/=-]{15,511}\b/g,
    confidence: 0.88,
    validate: looksLikeContextualSecret,
    requiresContext:
      /\b(?:access|refresh|auth(?:entication|orization)?|bearer|session|personal[\s_-]*access|webhook|csrf)[\s_-]*(?:token|secret|cookie|key)?\b|\b(?:token|session[\s_-]*id|cookie)\b/i,
  },

  // ---- Context-dependent: shape alone means nothing ---------------------
  {
    piiType: 'bank_account',
    pattern: /\b\d{9,18}\b/g,
    confidence: 0.75,
    requiresContext: /\b(?:a\/c|acc(?:oun)?t|bank)\b/i,
  },
  {
    piiType: 'roll_number',
    pattern: /\b[A-Z0-9][A-Z0-9/-]{4,19}\b/gi,
    confidence: 0.72,
    validate: looksLikePortalIdentifier,
    requiresContext: /\b(?:roll|enrol(?:l)?ment|student\s*(?:id|no)|usn|prn)\b/i,
  },
  {
    piiType: 'registration_number',
    pattern: /\b[A-Z0-9][A-Z0-9/-]{4,19}\b/gi,
    confidence: 0.72,
    validate: looksLikePortalIdentifier,
    requiresContext:
      /\b(?:regd?|registration|admission|application)\s*(?:no|num|number|id)?\b/i,
  },
  {
    piiType: 'date_of_birth',
    pattern: /\b(?:0?[1-9]|[12]\d|3[01])[/\-.](?:0?[1-9]|1[0-2])[/\-.](?:19|20)\d{2}\b/g,
    confidence: 0.8,
    requiresContext: /\b(?:d\.?o\.?b|date\s*of\s*birth|born|birth\s*date)\b/i,
  },
  {
    piiType: 'vehicle_number',
    pattern: /\b[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{4}\b/gi,
    confidence: 0.8,
    validate: isVehicleNumber,
  },
  {
    piiType: 'otp',
    pattern: /\b\d{4,8}\b/g,
    confidence: 0.85,
    requiresContext: /\b(?:otp|one[\s-]?time|verification\s*code|passcode|2fa|mfa)\b/i,
  },
  {
    piiType: 'cvv',
    pattern: /\b\d{3,4}\b/g,
    confidence: 0.85,
    requiresContext: /\b(?:cvv|cvc|csc|security\s*code|card\s*verification)\b/i,
  },
];

function hasContext(text: string, start: number, end: number, needle: RegExp): boolean {
  const from = Math.max(0, start - CONTEXT_WINDOW);
  const to = Math.min(text.length, end + CONTEXT_WINDOW);
  // Fresh regex per call: `lastIndex` on a shared /g/ instance would make this
  // return different answers for identical inputs.
  return new RegExp(needle.source, needle.flags.replace('g', '')).test(text.slice(from, to));
}

/**
 * Drop matches that overlap an already-accepted, higher-priority match.
 *
 * Without this, a GSTIN reports as itself *and* as the PAN inside it, and the
 * redactor ends up with two overlapping spans for one value — which produces
 * double-substituted text and a corrupted placeholder catalogue.
 */
function overlaps(match: PatternMatch, accepted: readonly PatternMatch[]): boolean {
  return accepted.some((a) => match.start < a.end && a.start < match.end);
}

/**
 * Scan text for sensitive values.
 *
 * `contextText` defaults to `text`. It is separate so a caller can pass the
 * element's label or surrounding copy as context while matching only against the
 * value — which is how a bare `<input>` value gets classified by its label.
 */
export function findPatterns(text: string, contextText?: string): PatternMatch[] {
  if (text === '') return [];
  const context = contextText ?? text;

  const accepted: PatternMatch[] = [];

  for (const rule of RULES) {
    // Fresh regex per rule per call, for the same `lastIndex` reason as above.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const value = match[0];

      // A zero-length match would loop forever; guard rather than trust the rule.
      if (value === '') {
        pattern.lastIndex++;
        continue;
      }

      const start = match.index;
      const end = start + value.length;

      if (rule.validate !== undefined && !rule.validate(value)) continue;
      if (
        rule.requiresContext !== undefined &&
        !hasContext(context, start, end, rule.requiresContext) &&
        !hasContext(text, start, end, rule.requiresContext)
      ) {
        continue;
      }
      if (
        overlaps({ piiType: rule.piiType, confidence: 0, start, end, text: value }, accepted)
      ) {
        continue;
      }

      accepted.push({
        piiType: rule.piiType,
        confidence: rule.confidence,
        start,
        end,
        text: value,
      });
    }
  }

  return accepted.sort((a, b) => a.start - b.start);
}

/** Exposed for tests and for the metrics harness. */
export function ruleCount(): number {
  return RULES.length;
}
