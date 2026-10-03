/**
 * Keeping what the user just typed.
 *
 * When the agent asks for something and gets an answer, throwing that answer away
 * after one use is a bad deal for the user twice over. They get asked the same
 * question every session, and — less obviously but more importantly — the value
 * never joins the redaction dictionary, so the next time it appears on screen the
 * detector has to fall back to guessing at its shape.
 *
 * That second effect is why this module exists. The vault is not a convenience
 * store bolted onto a privacy tool; it is the thing that makes redaction precise.
 * A password the vault knows is masked with certainty wherever it appears. A
 * password it has never seen is masked only if a pattern happens to fire.
 *
 * Two rules keep this from becoming a liability:
 *
 *   - Everything saved here is bound to the origin it was typed on, so a credential
 *     harvested by a look-alike page is refused rather than handed over.
 *   - One-time codes are stored in memory only. That is enforced by the vault's
 *     lifetime rules rather than by a check here, so it cannot be forgotten: an
 *     ephemeral type physically cannot reach `writeToDisk`.
 */

import { ALL_PII_TYPES, isEphemeral, type PiiType } from '@sih/core';
import * as vault from '../vault/index.ts';

/**
 * Work out what kind of value this is.
 *
 * The model's own `piiType` is preferred when it gave one, then the placeholder it
 * chose, then the category. Returning `undefined` means "do not store this", which
 * is the right answer for a CAPTCHA solution or a yes/no.
 */
export function inferType(options: {
  readonly category: string;
  readonly placeholderId: string;
  readonly piiType?: PiiType;
}): PiiType | undefined {
  if (options.piiType !== undefined && ALL_PII_TYPES.includes(options.piiType)) {
    return options.piiType;
  }

  // `AADHAAR_1`, `PASSWORD_PORTAL`, `ROLL_NUMBER_2`. Longest match first so
  // `registration_number` is not shadowed by a shorter type sharing a prefix.
  const token = options.placeholderId.toUpperCase();
  const byToken = [...ALL_PII_TYPES]
    .sort((a, b) => b.length - a.length)
    .find((type) => token.startsWith(type.toUpperCase()));
  if (byToken !== undefined) return byToken;

  switch (options.category) {
    case 'otp':
      return 'otp';
    case 'password':
      return 'password';
    // A security answer is a reusable credential in everything but name: it opens
    // the account and it is worth exactly as much to an attacker as the password.
    case 'security_answer':
      return 'secret_token';
    // A CAPTCHA answer is worthless a second later, and a confirmation is not a
    // value at all. Storing either would grow the vault without protecting anything.
    default:
      return undefined;
  }
}

/** Host as a person would say it, for the label the user will read in the list. */
function siteName(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return origin;
  }
}

export interface RememberOptions {
  readonly category: string;
  readonly placeholderId: string;
  /** The model's stated reason for asking. Used only to label the entry. */
  readonly reason: string;
  readonly value: string;
  /** Origin the value was typed on. This is what it gets bound to. */
  readonly origin: string;
  readonly piiType?: PiiType;
}

/**
 * Store the answer, bound to the site it was given on.
 *
 * Returns the label to show the user, or `undefined` when nothing durable was kept —
 * either because the value is not worth storing, or because it is a one-time code
 * that lives in memory only and saying "saved" about it would be a lie.
 */
export async function rememberAnswer(options: RememberOptions): Promise<string | undefined> {
  const piiType = inferType(options);
  if (piiType === undefined) return undefined;

  const host = siteName(options.origin);
  const readable = piiType.replace(/_/g, ' ');
  const label = host === '' || host === 'about:blank' ? readable : `${host} ${readable}`;

  try {
    // An existing entry for this type on this site is updated rather than
    // duplicated: the user re-entering a password means it changed, not that they
    // now have two.
    const existing = vault
      .list()
      .find((entry) => entry.piiType === piiType && entry.site === options.origin);

    await vault.put({
      piiType,
      label,
      value: options.value,
      site: options.origin,
      ...(existing === undefined ? {} : { slot: existing.slot }),
    });
  } catch {
    // A locked vault, or storage refusing the write. The task continues on the
    // in-memory copy the loop already holds; losing the convenience is not worth
    // interrupting the user over.
    return undefined;
  }

  // One-time codes were accepted above so the redactor can cover them on screen,
  // but they are never written anywhere and will not be there next session.
  return isEphemeral(piiType) ? undefined : label;
}
