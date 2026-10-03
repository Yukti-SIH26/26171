/**
 * Checksum validators for Indian identifiers.
 *
 * These exist to buy precision. A bare 12-digit regex matches an Aadhaar number,
 * but it also matches an order id, a transaction reference, a phone number with a
 * country code, and a timestamp. On a student portal those false positives are
 * everywhere, and every one of them gets blacked out of the screenshot, starving
 * the remote model of the context it needs to do its job.
 *
 * A checksum turns "twelve digits" into "twelve digits that could actually be an
 * Aadhaar number", which cuts the false-positive rate by roughly the inverse of
 * the check space — a factor of ten for Verhoeff, ten for Luhn. That is the
 * difference between a usable redaction budget and a black rectangle.
 *
 * Deliberately no network calls and no external data. A checksum proves internal
 * consistency, not that the identifier was ever issued to anyone.
 */

/**
 * Verhoeff dihedral group D5 multiplication table.
 *
 * Aadhaar uses Verhoeff rather than Luhn because it catches all single-digit
 * errors *and* all adjacent transpositions, which matters for numbers humans read
 * aloud and type back in.
 */
const VERHOEFF_D5: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;

/** Permutation table, applied cyclically by digit position. */
const VERHOEFF_P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

/** Strip spaces and hyphens, which Aadhaar and IFSC are commonly written with. */
export function normalizeDigits(value: string): string {
  return value.replace(/[\s-]/g, '');
}

/**
 * Verhoeff check over a digit string, including its trailing check digit.
 *
 * Digits are consumed right to left, which is what the position index in the
 * permutation table is defined against.
 */
export function verhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;

  let checksum = 0;
  for (let i = 0; i < digits.length; i++) {
    const digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    const permuted = VERHOEFF_P[i % 8]?.[digit];
    if (permuted === undefined) return false;
    const next = VERHOEFF_D5[checksum]?.[permuted];
    if (next === undefined) return false;
    checksum = next;
  }
  return checksum === 0;
}

/**
 * Is this a structurally valid Aadhaar number?
 *
 * Twelve digits, Verhoeff-checked, and not starting with 0 or 1 — UIDAI does not
 * issue those, and excluding them removes a large class of accidental matches
 * such as zero-padded reference numbers.
 */
export function isAadhaar(value: string): boolean {
  const digits = normalizeDigits(value);
  if (digits.length !== 12) return false;
  if (digits.startsWith('0') || digits.startsWith('1')) return false;
  return verhoeffValid(digits);
}

/**
 * Luhn check, used for payment card numbers.
 *
 * Same purpose as Verhoeff here: a 16-digit run is far too common on a page to
 * redact on sight.
 */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 12) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function isPaymentCard(value: string): boolean {
  const digits = normalizeDigits(value);
  return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
}

/**
 * Fourth character of a PAN encodes the holder type.
 *
 * P=individual, C=company, H=HUF, F=firm, A=AOP, T=trust, B=body of individuals,
 * L=local authority, J=artificial juridical person, G=government. Anything else
 * is not a PAN, and checking it rejects most random five-letter sequences.
 */
const PAN_HOLDER_TYPES = new Set(['P', 'C', 'H', 'F', 'A', 'T', 'B', 'L', 'J', 'G']);

/**
 * PAN: five letters, four digits, one letter.
 *
 * There is no published checksum, so the holder-type character is the only
 * structural constraint available beyond the shape itself.
 */
export function isPan(value: string): boolean {
  const upper = value.trim().toUpperCase();
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(upper)) return false;
  const holderType = upper[3];
  return holderType !== undefined && PAN_HOLDER_TYPES.has(holderType);
}

/**
 * IFSC: four bank letters, a reserved 0, then six alphanumerics.
 *
 * No checksum, but the mandatory fifth-character zero is a genuine constraint
 * that most eleven-character codes fail.
 */
export function isIfsc(value: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(value.trim().toUpperCase());
}

/**
 * Indian mobile number: ten digits starting 6-9, optionally +91 prefixed.
 *
 * The leading-digit rule is what separates a phone number from an arbitrary
 * ten-digit run such as a roll number or an amount in paise.
 */
export function isIndianMobile(value: string): boolean {
  const digits = normalizeDigits(value).replace(/^\+?91/, '');
  return /^[6-9]\d{9}$/.test(digits);
}

/**
 * Indian passport: one letter, seven digits, with Q/X/Z excluded.
 *
 * Those letters are not used in the series, so rejecting them removes matches on
 * things like "Z1234567" that appear in reference codes.
 */
export function isPassport(value: string): boolean {
  return /^[A-PR-WY][1-9]\d{6}$/.test(value.trim().toUpperCase());
}

/**
 * GSTIN: two state digits, a PAN, an entity digit, 'Z', then a check character.
 *
 * The embedded PAN is validated with the same holder-type rule, which makes this
 * the most constrained identifier in the set and effectively false-positive free.
 */
export function isGstin(value: string): boolean {
  const upper = value.trim().toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z0-9]$/.test(upper)) return false;
  const stateCode = Number(upper.slice(0, 2));
  if (stateCode < 1 || stateCode > 38) return false;
  return isPan(upper.slice(2, 12));
}

/**
 * Vehicle registration, e.g. `MH12AB1234` or `DL 3C AB 1234`.
 *
 * Included because a student portal's transport or hostel page often shows one,
 * and it identifies a person's vehicle as directly as a phone number identifies
 * their phone.
 */
export function isVehicleNumber(value: string): boolean {
  const compact = value.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(compact);
}
