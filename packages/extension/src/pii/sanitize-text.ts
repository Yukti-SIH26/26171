import type { PiiType } from '@sih/core';
import { containsKnownValue, findKnownValues, type KnownValue } from './known-values.ts';
import { findPatterns } from './patterns.ts';

export interface SensitiveTextMatch {
  readonly piiType: PiiType;
  readonly start: number;
  readonly end: number;
  /** Local-only literal. Callers must never serialize this object. */
  readonly value: string;
  readonly source: 'known_value' | 'pattern' | 'label';
}

export interface SanitizedText {
  readonly text: string;
  readonly matches: readonly SensitiveTextMatch[];
}

interface LabelRule {
  readonly piiType: PiiType;
  readonly pattern: RegExp;
  /**
   * Extra test on the captured value.
   *
   * Needed where the separator is optional. "password Hunter2Hunter2" must be caught,
   * but "password field" must not, or ordinary phrasing in the request gets mangled and
   * the reasoning side stops being able to read what was asked.
   */
  readonly validate?: (value: string) => boolean;
}

/** Long enough and mixed enough to be a credential rather than an English word. */
function looksLikeCredential(value: string): boolean {
  if (value.length < 6) return false;
  if (/^(?:field|value|box|input|prompt|manager|reset|again|here|below|above)$/i.test(value)) {
    return false;
  }
  return /\d/.test(value) || value.length >= 12 || /[^A-Za-z0-9]/.test(value);
}

/**
 * Values whose shape alone is not distinctive enough to detect safely. These rules
 * require an explicit human label and capture only the value portion.
 */
const LABELLED_VALUES: readonly LabelRule[] = [
  {
    piiType: 'password',
    pattern: /\b(?:password|passwd|pwd|login\s*pin)\s*(?:is|=|:)?\s*["']?([^\s"',;]+)/gi,
    validate: looksLikeCredential,
  },
  {
    piiType: 'api_key',
    pattern:
      /\b(?:api|access|secret|client|developer|subscription|signing)[\s_-]*(?:key|secret)\s*(?:is|=|:)?\s*["']?([^\s"',;]+)/gi,
    validate: looksLikeCredential,
  },
  {
    piiType: 'secret_token',
    pattern:
      /\b(?:access|refresh|auth|bearer|session|personal[\s_-]*access|webhook)[\s_-]*(?:token|secret|cookie)?\s*(?:is|=|:)?\s*["']?([^\s"',;]+)/gi,
    validate: looksLikeCredential,
  },
  {
    piiType: 'registration_number',
    pattern:
      /\b(?:registration|application|admission)\s*(?:number|no|id)?\s*(?:is|=|:)\s*["']?([A-Z0-9][A-Z0-9/_-]{3,})/gi,
  },
  {
    piiType: 'roll_number',
    pattern:
      /\b(?:roll|student|enrolment|enrollment)\s*(?:number|no|id)?\s*(?:is|=|:)\s*["']?([A-Z0-9][A-Z0-9/_-]{3,})/gi,
  },
  {
    piiType: 'person_name',
    pattern:
      /\b(?:my\s+name|full\s+name|student\s+name)\s*(?:is|=|:)\s*["']?([\p{L}][\p{L} .'-]{1,60}?)(?=\s+(?:and|then|with|at|on|from)\b|[",;\n]|$)/giu,
  },
  {
    piiType: 'address',
    pattern:
      /\b(?:my\s+address|home\s+address|postal\s+address|address)\s*(?:is|=|:)\s*["']?([^";\n]{5,160}?)(?=\s+(?:and|then)\b|[";\n]|$)/gi,
  },
];

function labelledMatches(text: string): SensitiveTextMatch[] {
  const out: SensitiveTextMatch[] = [];
  for (const rule of LABELLED_VALUES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[1];
      if (value === undefined || value === '') continue;
      if (rule.validate !== undefined && !rule.validate(value)) continue;
      const relative = match[0].lastIndexOf(value);
      if (relative < 0) continue;
      const start = match.index + relative;
      out.push({
        piiType: rule.piiType,
        start,
        end: start + value.length,
        value,
        source: 'label',
      });
    }
  }
  return out;
}

/** Find sensitive spans in arbitrary local text without requiring page geometry. */
export function findSensitiveText(
  text: string,
  known: readonly KnownValue[] = [],
): SensitiveTextMatch[] {
  if (text === '') return [];

  const candidates: SensitiveTextMatch[] = [
    ...findKnownValues(text, known).map((match) => ({
      piiType: match.piiType,
      start: match.start,
      end: match.end,
      value: match.text,
      source: 'known_value' as const,
    })),
    ...findPatterns(text).map((match) => ({
      piiType: match.piiType,
      start: match.start,
      end: match.end,
      value: match.text,
      source: 'pattern' as const,
    })),
    ...labelledMatches(text),
  ];

  // Strongest source and longest span win overlaps. This keeps one deterministic
  // replacement where, for example, a known value is also a vendor-shaped API key.
  const priority = { known_value: 3, pattern: 2, label: 1 } as const;
  candidates.sort(
    (a, b) =>
      priority[b.source] - priority[a.source] ||
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start,
  );

  const accepted: SensitiveTextMatch[] = [];
  for (const candidate of candidates) {
    if (candidate.start < 0 || candidate.end > text.length || candidate.start >= candidate.end)
      continue;
    if (accepted.some((item) => candidate.start < item.end && item.start < candidate.end))
      continue;
    accepted.push(candidate);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

/**
 * Sanitize task text, history, errors, and any other non-page string before egress.
 * A replacement callback lets the local session controller expose opaque handles
 * without exposing the values those handles represent.
 */
export function sanitizeOutboundText(
  text: string,
  known: readonly KnownValue[] = [],
  replacementFor: (match: SensitiveTextMatch, index: number) => string = (match) =>
    `<HIDDEN_${match.piiType.toUpperCase()}>`,
): SanitizedText {
  const matches = findSensitiveText(text, known);
  if (matches.length === 0) return { text: sanitizeEmbeddedUrls(text), matches };

  let output = text;
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index];
    if (match === undefined) continue;
    output =
      output.slice(0, match.start) + replacementFor(match, index) + output.slice(match.end);
  }
  return { text: sanitizeEmbeddedUrls(output), matches };
}

/** Strip paths, queries, fragments, and credentials from URLs embedded in free text. */
export function sanitizeEmbeddedUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      return new URL(raw).origin;
    } catch {
      return '<HIDDEN_URL>';
    }
  });
}

export function safeOrigin(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : 'about:blank';
  } catch {
    return 'about:blank';
  }
}

/**
 * Final fail-closed check over text immediately before serialization.
 *
 * Deliberately checks *literals only*: values the user stored or supplied, and values
 * already stripped from this payload. It does not re-run shape detection over the
 * serialized request, because that request also contains our own vocabulary — the
 * system prompt, placeholder handles, action names, the words "token" and "secret" —
 * and scanning vocabulary for secrets produces false alarms rather than safety. That
 * mistake blocked every send and every screenshot until it was removed.
 *
 * Page content is protected upstream by the detector, the value sweep, and the packet
 * canary; this is the last check that no known literal survived any of them.
 */
export function outboundTextIsSafe(
  text: string,
  known: readonly KnownValue[] = [],
  removed: readonly SensitiveTextMatch[] = [],
): boolean {
  if (text === '') return true;
  if (containsKnownValue(text, known)) return false;
  return !removed.some((match) => match.value.length >= 5 && text.includes(match.value));
}
