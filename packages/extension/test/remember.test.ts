import { describe, expect, it } from 'vitest';
import { inferType } from '../src/agent/remember.ts';

/**
 * What the agent keeps after asking a question.
 *
 * This matters more than it looks. Every value stored becomes something the
 * known-value detector can recognise with certainty, so a password the vault has seen
 * is masked wherever it appears, while one it has not is masked only if a pattern
 * happens to fire. Storing the right things is a redaction improvement, not just a
 * convenience.
 *
 * The inverse matters too: storing a CAPTCHA answer or a yes/no grows the vault
 * without protecting anything, so those return nothing.
 */

describe('inferType', () => {
  it('trusts the type the model named', () => {
    expect(inferType({ category: 'other', placeholderId: 'X_1', piiType: 'aadhaar' })).toBe(
      'aadhaar',
    );
  });

  it('reads the type off the placeholder the model chose', () => {
    expect(inferType({ category: 'other', placeholderId: 'AADHAAR_1' })).toBe('aadhaar');
    expect(inferType({ category: 'other', placeholderId: 'PASSWORD_PORTAL' })).toBe('password');
    expect(inferType({ category: 'other', placeholderId: 'EMAIL_WORK' })).toBe('email');
  });

  /**
   * Longest match first, or `registration_number` is shadowed by a shorter type
   * sharing its prefix and every registration number is filed as something else.
   */
  it('prefers the longest matching type name', () => {
    expect(inferType({ category: 'other', placeholderId: 'REGISTRATION_NUMBER_1' })).toBe(
      'registration_number',
    );
    expect(inferType({ category: 'other', placeholderId: 'DATE_OF_BIRTH_1' })).toBe(
      'date_of_birth',
    );
  });

  it('falls back to the category when the placeholder says nothing', () => {
    expect(inferType({ category: 'otp', placeholderId: 'CODE_1' })).toBe('otp');
    expect(inferType({ category: 'password', placeholderId: 'SECRET' })).toBe('password');
  });

  /** A security answer opens the account. It is a credential in everything but name. */
  it('treats a security answer as a credential', () => {
    expect(inferType({ category: 'security_answer', placeholderId: 'ANSWER_1' })).toBe(
      'secret_token',
    );
  });

  it('stores nothing for values that are worthless a second later', () => {
    expect(inferType({ category: 'captcha', placeholderId: 'CAPTCHA_1' })).toBeUndefined();
    expect(inferType({ category: 'confirmation', placeholderId: 'YES' })).toBeUndefined();
    expect(inferType({ category: 'other', placeholderId: 'SOMETHING' })).toBeUndefined();
  });

  /** A type the model invented is not a type. */
  it('ignores a piiType that is not in the taxonomy', () => {
    expect(
      inferType({
        category: 'captcha',
        placeholderId: 'X',
        // Deliberately outside the union, which is what a confused model would send.
        piiType: 'nonsense' as never,
      }),
    ).toBeUndefined();
  });
});
