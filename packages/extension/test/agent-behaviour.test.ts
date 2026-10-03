/**
 * Behaviour the agent has to get right on messy, arbitrary requests.
 *
 * Every case here is a failure that actually happened in a live run, or a guard that
 * broke a legitimate request while trying to prevent one. They are written against the
 * plain functions rather than the whole loop so a regression names itself.
 */

import { describe, expect, it } from 'vitest';
import { GENERIC_SITE_WORDS, isFillerText, looksInvented } from '../src/agent/loop.ts';
import { outboundTextIsSafe, sanitizeOutboundText } from '../src/pii/sanitize-text.ts';
import { systemPrompt } from '../src/llm/prompt.ts';
import { parseAction } from '../src/llm/parse.ts';

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

describe('looksInvented', () => {
  /**
   * The live failure: asked for a named institution's portal, the model composed
   * `erp.college.edu` out of the words in the request and loaded nothing.
   */
  it('refuses an address made of generic role words', () => {
    expect(looksInvented('https://erp.college.edu')).toBe(true);
    expect(looksInvented('https://portal.university.edu/login')).toBe(true);
    expect(looksInvented('https://login.bank.com')).toBe(true);
    expect(looksInvented('https://example.com')).toBe(true);
  });

  /**
   * The guard that replaced it must not block real sites. This list is deliberately
   * the kind of thing a user asks for — a developer console, a bank, a card network,
   * an unrelated product — because an over-eager guard breaks every one of them.
   */
  it('allows real organisation addresses', () => {
    for (const url of [
      'https://openrouter.ai/keys',
      'https://console.groq.com',
      'https://www.visa.co.in',
      'https://www.icicibank.com',
      'https://huggingface.co/settings/tokens',
      'https://www.digilocker.gov.in/',
      'https://duckduckgo.com/?q=something',
      'https://www.odisha.gov.in',
    ]) {
      expect(looksInvented(url), url).toBe(false);
    }
  });

  it('refuses anything that is not a usable address at all', () => {
    expect(looksInvented('not a url')).toBe(true);
    expect(looksInvented('https://localhost')).toBe(true);
  });

  it('matches role words only as the registrable name', () => {
    // `portal` as part of a brand is a brand, not a description.
    expect(GENERIC_SITE_WORDS.test('portal')).toBe(true);
    expect(GENERIC_SITE_WORDS.test('portalnews')).toBe(false);
    expect(GENERIC_SITE_WORDS.test('openrouter')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Placeholder text
// ---------------------------------------------------------------------------

describe('isFillerText', () => {
  /** The live failure: the words "your college name" typed into a search box. */
  it('refuses a description of a value', () => {
    for (const text of [
      'your college name',
      'Your College Name',
      'my bank website',
      'the portal name',
      '<site name>',
      '[registration number]',
      'e.g. 21CS042',
      'placeholder',
      'xxxxx',
    ]) {
      expect(isFillerText(text), text).toBe(true);
    }
  });

  it('allows real queries and values a user would actually want typed', () => {
    for (const text of [
      'OUTR ERP login',
      'odisha university of technology and research',
      'create api key',
      'visa credit card offers',
      'attendance',
      '23110572',
      'Semester 5',
      'your-name@example.com'.replace('your-name', 'asha'),
    ]) {
      expect(isFillerText(text), text).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Arbitrary requests must survive sanitisation intact
// ---------------------------------------------------------------------------

describe('request sanitisation on arbitrary commands', () => {
  /**
   * The request is the one thing the reasoning side needs verbatim to work out intent.
   * Mangling it — which an over-broad detector does — is how the agent stops
   * understanding what was asked.
   */
  it('leaves ordinary requests, typos and all, untouched', () => {
    for (const task of [
      'go to my college webite outr open it go to erp login it and downlaod my admit crad',
      'open openrouter and craete a key fro me',
      'go to xyz bank login',
      'go to visa site and find offers',
      'what is on my screen',
      'read this page and tell me what it is',
      'serach for the ipl schedule',
    ]) {
      expect(sanitizeOutboundText(task, []).text, task).toBe(task);
    }
  });

  it('still removes a value the user typed into the request itself', () => {
    const result = sanitizeOutboundText('login with password Hunter2Hunter2', []);
    expect(result.text).not.toContain('Hunter2Hunter2');
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('reduces an embedded link to its origin', () => {
    const result = sanitizeOutboundText(
      'open https://portal.example.edu/student/21CS042?s=9',
      [],
    );
    expect(result.text).toContain('https://portal.example.edu');
    expect(result.text).not.toContain('21CS042');
  });
});

// ---------------------------------------------------------------------------
// The check that blocked every request
// ---------------------------------------------------------------------------

describe('outboundTextIsSafe', () => {
  /**
   * The regression that stopped the product working: the check re-ran shape detection
   * over the whole request, matched our own vocabulary — "token", "secret", handle
   * names — and refused to send anything at all.
   */
  it('does not fire on our own prompt and handle vocabulary', () => {
    expect(outboundTextIsSafe(systemPrompt(), [])).toBe(true);
    expect(
      outboundTextIsSafe(
        JSON.stringify({
          placeholders: [
            { token: 'REGISTRATION_NUMBER_LOCAL_ABCDEFGHIJ', piiType: 'registration_number' },
          ],
          note: 'available local handles are usable values; never echo a secret token',
        }),
        [],
      ),
    ).toBe(true);
  });

  it('fires on a real stored value, however it is formatted', () => {
    const known = [{ piiType: 'aadhaar' as const, value: '432187652109', slot: 'aadhaar1' }];
    expect(outboundTextIsSafe('id 4321 8765 2109 on screen', known)).toBe(false);
    expect(outboundTextIsSafe('nothing sensitive here', known)).toBe(true);
  });

  it('fires when a literal stripped from the request reappears', () => {
    const removed = [
      {
        piiType: 'password' as const,
        start: 0,
        end: 12,
        value: 'Hunter2Hunter2',
        source: 'label' as const,
      },
    ];
    expect(outboundTextIsSafe('the value is Hunter2Hunter2', [], removed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Whatever the model replies with, the local side must cope
// ---------------------------------------------------------------------------

describe('parseAction on hostile and sloppy replies', () => {
  it('keeps the goal and plan when the model supplies them', () => {
    const parsed = parseAction(
      JSON.stringify({
        goal: 'open the ERP login page and download the admit card',
        plan: ['search for the college', 'open the ERP login page'],
        action: { type: 'goto_url', url: 'https://duckduckgo.com' },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.goal).toContain('admit card');
    expect(parsed.plan?.length).toBe(2);
  });

  it('keeps the requested value type so the answer can be reused', () => {
    const parsed = parseAction(
      '{"action":{"type":"request_user_input","category":"missing_profile_field",' +
        '"piiType":"registration_number","reason":"needed","placeholderId":"REGISTRATION_NUMBER_LOCAL_A"}}',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.action.type !== 'request_user_input') return;
    expect(parsed.action.piiType).toBe('registration_number');
  });

  it('refuses prose, empty replies and unknown actions instead of guessing', () => {
    for (const reply of [
      'I will now open the site.',
      '',
      '{}',
      '{"action":{"type":"hack_the_page"}}',
    ]) {
      expect(parseAction(reply).ok, reply).toBe(false);
    }
  });

  it('tolerates a fenced reply with commentary around it', () => {
    const parsed = parseAction(
      'Sure!\n```json\n{"action":{"type":"scroll","direction":"down"}}\n```\n',
    );
    expect(parsed.ok).toBe(true);
  });
});
