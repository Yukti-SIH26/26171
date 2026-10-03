/**
 * PII detection.
 *
 * Three deterministic layers ship today: known-value (vault dictionary),
 * structural (markup declarations), and pattern (format plus checksum). A fourth,
 * semantic NER, is planned — it is the layer that generalizes to formats nobody
 * wrote a rule for, and until it lands the honest position is that recall on
 * unusual layouts depends on the vault being filled in.
 */

export { findPatterns, ruleCount, type PatternMatch } from './patterns.ts';
export {
  classifyElement,
  declaredSensitiveFields,
  hasConflictingSignals,
  type StructuralFinding,
} from './structural.ts';
export {
  MIN_SEARCHABLE_LENGTH,
  containsKnownValue,
  findKnownValues,
  searchPatternFor,
  type KnownValue,
  type KnownValueMatch,
} from './known-values.ts';
export {
  detectPii,
  type DetectInput,
  type DetectResult,
  type DetectStats,
  type PiiFinding,
  type TextField,
} from './detect.ts';
export {
  findSensitiveText,
  outboundTextIsSafe,
  safeOrigin,
  sanitizeEmbeddedUrls,
  sanitizeOutboundText,
  type SanitizedText,
  type SensitiveTextMatch,
} from './sanitize-text.ts';
