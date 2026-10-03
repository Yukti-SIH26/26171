/**
 * Known-value detector — layer 1 of four, and the most precise.
 *
 * Matches text against values the user has told us are theirs. If the vault holds
 * the Aadhaar number 4321 8765 2109, then that exact string appearing anywhere on
 * a page is that Aadhaar number — no format guessing, no checksum needed, no
 * false positives.
 *
 * This layer raises precision and recall at the same time, which is unusual. It
 * finds values that no pattern covers (a person's name, a street address) and it
 * never fires on a lookalike, because it is matching a literal the user supplied.
 *
 * Two design points that matter more than they look:
 *
 *  - Matching is normalised, not exact. `4321 8765 2109`, `4321-8765-2109`, and
 *    `432187652109` are the same Aadhaar number, and a page will render whichever
 *    it likes. Normalising both sides is what makes the detector work on real
 *    pages rather than only on ones formatted the way the vault was filled in.
 *
 *  - Short values are excluded. A vault entry of "12" or a two-letter name would
 *    match constantly and black out half the page. The floor is a deliberate
 *    trade: we lose a handful of genuinely short values to keep the redaction
 *    budget intact.
 *
 * No vault values are ever sent anywhere. This module holds them in memory only
 * for the duration of a scan, and the caller is responsible for clearing them.
 */

import type { PiiType } from '@sih/core';

export interface KnownValue {
  readonly piiType: PiiType;
  /** The literal the user stored. Never leaves the device. */
  readonly value: string;
  /**
   * Stable handle for the vault entry, used to build the placeholder the server
   * sees (`AADHAAR_1`). Lets two different Aadhaar numbers stay distinguishable
   * to the remote model without either being disclosed.
   */
  readonly slot: string;
}

export interface KnownValueMatch {
  readonly piiType: PiiType;
  readonly slot: string;
  readonly confidence: number;
  readonly start: number;
  readonly end: number;
  /** The text as it appeared on the page, which is what must be painted over. */
  readonly text: string;
}

/**
 * Minimum length for a value to be searched for.
 *
 * Below this, matches are overwhelmingly coincidental. Five characters keeps
 * genuinely identifying values (a PIN code, a short surname) while dropping the
 * ones that would match inside every other word on the page.
 */
const MIN_SEARCHABLE_LENGTH = 5;

/**
 * Types compared with separators stripped.
 *
 * Applies to identifiers that are digit- or code-shaped, where formatting is
 * cosmetic. Deliberately not applied to names and addresses, where whitespace is
 * meaningful and stripping it would create matches across word boundaries.
 */
const SEPARATOR_INSENSITIVE: ReadonlySet<PiiType> = new Set<PiiType>([
  'aadhaar',
  'pan',
  'credit_card',
  'bank_account',
  'ifsc',
  'phone',
  'passport',
  'driving_licence',
  'voter_id',
  'gstin',
  'roll_number',
  'registration_number',
  'vehicle_number',
  'date_of_birth',
]);

function stripSeparators(value: string): string {
  return value.replace(/[\s\-/.()]/g, '');
}

/**
 * Build a regex that matches a literal with optional separators between every
 * character.
 *
 * This is what lets a vault entry of `432187652109` match the page text
 * `4321 8765 2109`. Doing it as a pattern rather than by normalising the page
 * text is essential: we need the match offsets in the *original* string so the
 * redactor knows which pixels to cover.
 */
function separatorTolerantPattern(value: string): RegExp {
  const chars = [...stripSeparators(value)].map((c) =>
    c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  return new RegExp(chars.join('[\\s\\-/.]?'), 'gi');
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary-aware literal pattern, for values where spacing is meaningful.
 *
 * `\b` is used so a stored name "Ram" cannot match inside "Rampur". For values
 * that start or end with a non-word character the boundary is dropped, since
 * `\b` would never match there.
 */
function literalPattern(value: string): RegExp {
  const escaped = escapeLiteral(value);
  const leading = /^\w/.test(value) ? '\\b' : '';
  const trailing = /\w$/.test(value) ? '\\b' : '';
  return new RegExp(`${leading}${escaped}${trailing}`, 'gi');
}

/**
 * Find every occurrence of every known value in a piece of text.
 *
 * Longer values win overlaps. A full address contains the city name, and the
 * useful report is "the address is here", not two findings fighting over the same
 * characters.
 */
export function findKnownValues(text: string, vault: readonly KnownValue[]): KnownValueMatch[] {
  if (text === '' || vault.length === 0) return [];

  const candidates: KnownValueMatch[] = [];

  for (const entry of vault) {
    const value = entry.value.trim();
    if (value.length < MIN_SEARCHABLE_LENGTH) continue;

    const pattern = SEPARATOR_INSENSITIVE.has(entry.piiType)
      ? separatorTolerantPattern(value)
      : literalPattern(value);

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const found = match[0];
      if (found === '') {
        pattern.lastIndex++;
        continue;
      }
      candidates.push({
        piiType: entry.piiType,
        slot: entry.slot,
        // The user asserted this value is theirs, and we found it verbatim.
        // There is no inference left to be uncertain about.
        confidence: 1,
        start: match.index,
        end: match.index + found.length,
        text: found,
      });
    }
  }

  candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);

  const accepted: KnownValueMatch[] = [];
  for (const candidate of candidates) {
    if (accepted.some((a) => candidate.start < a.end && a.start < candidate.end)) continue;
    accepted.push(candidate);
  }

  return accepted.sort((a, b) => a.start - b.start);
}

/**
 * The pattern this module would use to find one value.
 *
 * Exported so the outbound scrubber searches for a value exactly the way the detector
 * found it. Those two drifting apart is a leak, not an inconsistency: the detector
 * matches the page text `4321 8765 2109` against a vault entry of `432187652109`,
 * and a scrubber replacing only the literal it was handed would leave the spaced copy
 * on the wire.
 *
 * Returns `undefined` for a value too short to search for safely.
 */
export function searchPatternFor(piiType: PiiType, value: string): RegExp | undefined {
  const trimmed = value.trim();
  if (trimmed.length < MIN_SEARCHABLE_LENGTH) return undefined;
  return SEPARATOR_INSENSITIVE.has(piiType)
    ? separatorTolerantPattern(trimmed)
    : literalPattern(trimmed);
}

/**
 * Does this text contain any known value at all?
 *
 * Used by the leak canary on the outbound path, where the only question is
 * whether a secret survived redaction — not where it is. Short-circuits on the
 * first hit, so it is cheap enough to run over every outbound payload.
 */
export function containsKnownValue(text: string, vault: readonly KnownValue[]): boolean {
  if (text === '') return false;
  for (const entry of vault) {
    const pattern = searchPatternFor(entry.piiType, entry.value);
    if (pattern !== undefined && pattern.test(text)) return true;
  }
  return false;
}

export { MIN_SEARCHABLE_LENGTH };
