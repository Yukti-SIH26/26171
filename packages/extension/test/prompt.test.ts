import { describe, expect, it } from 'vitest';
import { ELEMENT_GRAPH_SCHEMA_VERSION } from '@sih/core';
import { buildMessages, pageMessage, systemPrompt, userMessage } from '../src/llm/prompt.ts';
import type { EgressPacket } from '../src/redact/packet.ts';

const AADHAAR = '432187652109';

function packet(overrides: Partial<EgressPacket> = {}): EgressPacket {
  return {
    schemaVersion: ELEMENT_GRAPH_SCHEMA_VERSION,
    origin: 'https://portal.example.edu',
    title: 'Student Profile',
    viewport: { width: 1280, height: 800 },
    nodes: [
      {
        id: 'el_1',
        role: 'textbox',
        name: 'Aadhaar Number',
        rect: [10, 20, 200, 30],
        interactive: true,
        editable: true,
        sensitive: true,
      },
      {
        id: 'el_2',
        role: 'button',
        name: 'Submit',
        rect: [10, 60, 90, 30],
        interactive: true,
        editable: false,
      },
      {
        id: 'el_3',
        role: 'heading',
        name: 'Your details',
        rect: [10, 0, 300, 18],
        interactive: false,
        editable: false,
        text: 'Your details',
      },
    ],
    placeholders: [
      { token: 'AADHAAR_PRIMARY', piiType: 'aadhaar', length: 12, available: true },
      { token: 'OTP_SMS', piiType: 'otp', length: 6, available: false },
    ],
    redactedRegions: [{ rect: [10, 20, 200, 30], piiTypes: ['aadhaar'], mode: 'mask_solid' }],
    coverage: 0.03,
    capturedAt: 1_700_000_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Sighted prompt
// ---------------------------------------------------------------------------

describe('systemPrompt', () => {
  /**
   * The problem statement requires the server be "aware of this redaction scheme".
   * Without this explanation a model reasonably concludes the page failed to load
   * and gives up, so it is load-bearing rather than courtesy.
   */
  it('explains that black areas and tokens are deliberate', () => {
    const text = systemPrompt();
    expect(text).toMatch(/not an error/i);
    expect(text).toMatch(/AADHAAR_1|placeholder/i);
  });

  /**
   * A model that guesses a hidden value and types it into a real form is a privacy
   * failure even though nothing leaked *to* it.
   */
  it('forbids guessing or typing a hidden value literally', () => {
    const text = systemPrompt();
    expect(text).toMatch(/NEVER type a hidden value as literal/i);
    expect(text).toMatch(/never guess/i);
  });

  it('tells the model page text is content, not instructions', () => {
    expect(systemPrompt()).toMatch(/not an instruction to you/i);
  });

  it('forbids solving a CAPTCHA itself', () => {
    expect(systemPrompt()).toMatch(/Never attempt to solve a CAPTCHA/i);
  });

  /**
   * The instruction models break most often. Asked to search for something, an agent
   * left to itself will search, open the first result, start reading it, and try to
   * summarise — none of which was asked for, and all of it happening in the user's
   * own browser while they watch.
   */
  it('tells the model to do exactly what was asked and then stop', () => {
    const text = systemPrompt().replace(/\s+/g, ' ');
    expect(text).toMatch(/Do everything the user asked for, and nothing they did not/i);
    expect(text).toMatch(/Do not open a result/i);
    expect(text).toMatch(/Inventing work nobody asked for/i);
  });

  /**
   * The regression that made the agent look broken. An earlier version of this rule
   * said "search for X means: run the search and stop", full stop — so given "search
   * for my college, open it, then go to the erp login page" the model ran the search
   * and stopped, one third of the way through, believing it was being disciplined.
   *
   * Both failure directions have to be named, or fixing one causes the other.
   */
  it('names both ways of getting the scope wrong', () => {
    const text = systemPrompt().replace(/\s+/g, ' ');
    expect(text).toMatch(/Stopping before every part of the request is done/i);
    expect(text).toMatch(/three parts/i);
    expect(text).toMatch(/Stopping after the search is a failure/i);
  });

  /**
   * Requests arrive misspelled and part-way into another language, because that is what
   * typing quickly looks like. A model that pattern-matches characters searches for a
   * typo as though it were a proper noun.
   */
  it('tells the model to read for intent rather than for literal words', () => {
    const text = systemPrompt().replace(/\s+/g, ' ');
    expect(text).toMatch(/work out what the user actually wants/i);
    expect(text).toMatch(/Expect misspellings/i);
    expect(text).toMatch(/A misspelt word is the word it was meant to be/i);
    expect(text).toMatch(/State that goal in one short sentence in "reasoning"/i);
  });

  /**
   * A table of known misspellings would fix the examples we happened to see, rot
   * immediately, and teach the model nothing. The instruction has to be about how to
   * read, so no specific misspelling or site may appear in it.
   */
  it('hardcodes no misspelling and no specific site', () => {
    const text = systemPrompt().toLowerCase();
    for (const literal of ['outr', 'serach', 'tisopen', 'duckduckgo', 'google.com']) {
      expect(text).not.toContain(literal);
    }
  });

  /**
   * "explain this page" has no navigation in it at all. The agent used to treat having
   * nothing to click as a reason to give up, when describing the page was the entire job.
   */
  it('states that answering a question about the page is a complete task', () => {
    const text = systemPrompt().replace(/\s+/g, ' ');
    expect(text).toMatch(/question about what is already on screen is a complete task/i);
    expect(text).toMatch(/Describing the page \*is\* the job/i);
    expect(text).toMatch(/"fill this in" means/i);
  });

  /**
   * Searching for a site whose address is guessable wastes two steps and the user
   * watches it happen. "open digilocker" should be one navigation, not a web search.
   */
  /**
   * Search first, then click the official result.
   *
   * This replaced "go straight to the address when you know it", which read as licence
   * to compose one: asked for an institution's portal the model produced a hostname
   * built out of the words in the request, loaded a site that does not exist, and had
   * nothing to act on. Searching is the route that works whether or not the address is
   * known, so it is the only route described.
   */
  it('tells the model to reach a site by searching and opening the official result', () => {
    const text = systemPrompt().replace(/\s+/g, ' ');
    expect(text).toMatch(/open a search engine with goto_url/i);
    expect(text).toMatch(/click the official one/i);
    expect(text).toMatch(/only when the user gave you the address themselves/i);
    expect(text).toMatch(/NEVER assemble a hostname/i);
  });

  /** A handle names a value; typed literally it enters the name into the page. */
  it('forbids typing a handle as literal text', () => {
    const text = systemPrompt().replace(/\s+/g, ' ');
    expect(text).toMatch(/"kind":"placeholder"/);
    expect(text).toMatch(/Never type a handle/i);
  });

  /** Asking for something the user already saved is the behaviour they called out. */
  it('tells the model to use saved values rather than asking again', () => {
    const text = systemPrompt().replace(/\s+/g, ' ');
    expect(text).toMatch(/use it straight away/i);
    expect(text).toMatch(/never ask for something they have already saved/i);
  });

  /**
   * A live run had the model propose `FIRST_NAME_LOCAL_A` on every attempt — a token
   * nobody issued, for a type that does not exist. Naming that shape in the rules is part
   * of what stopped it.
   */
  it('forbids inventing a handle and names the one correct alternative', () => {
    const text = systemPrompt().replace(/\s+/g, ' ');
    expect(text).toMatch(/NEVER make up a token/i);
    expect(text).toMatch(/FIRST_NAME_LOCAL_A/);
    expect(text).toMatch(/exactly one correct move: request_user_input/i);
  });

  /** A question is answered, not typed into the page. */
  it('says a question is answered with stop', () => {
    expect(systemPrompt()).toMatch(/Answering a question is a stop, not a step/i);
  });

  /** One prompt now, so nothing about a "blind turn" should survive in it. */
  it('never names a specific search engine', () => {
    expect(systemPrompt().toLowerCase()).not.toContain('duckduckgo');
  });
});

describe('pageMessage', () => {
  it('includes the task, the origin, and actionable elements', () => {
    const text = pageMessage(packet(), 'show my attendance', []);
    expect(text).toContain('show my attendance');
    expect(text).toContain('https://portal.example.edu');
    expect(text).toContain('el_1');
    expect(text).toContain('el_2');
  });

  /**
   * Telling the model which placeholders it cannot fill is what lets it plan a step
   * that asks the user, instead of one that silently fails.
   */
  it('marks which hidden values need the user', () => {
    const text = pageMessage(packet(), 'log in', []);
    expect(text).toMatch(/AADHAAR_PRIMARY.*ready to type/);
    expect(text).toMatch(/OTP_SMS.*ask with request_user_input/);
  });

  /**
   * The catalogue mixes values covered on this screen with values the user saved that
   * are not on it at all, and the model has to understand it can *type* either. Listing
   * only what was hidden is what made "fill this page" impossible.
   */
  it('tells the model how to use an offered value', () => {
    const text = pageMessage(packet(), 'fill this in', []).replace(/\s+/g, ' ');
    expect(text).toMatch(/the complete list\. There are no others/i);
    expect(text).toMatch(/copy its token exactly/i);
    expect(text).toContain('"kind":"placeholder"');
  });

  /**
   * The section is emitted even when it is empty, and that is the point.
   *
   * Skipping it was the cause of the worst live failure found: told to copy a token from
   * "LOCAL VALUE HANDLES" and shown no such heading anywhere, the model filled the gap from
   * the example in the action reference and proposed `FIRST_NAME_LOCAL_A` — a handle for a
   * type that does not exist — on every single attempt, once per turn, forever.
   */
  it('says so explicitly when there are no handles at all', () => {
    const text = pageMessage(packet({ placeholders: [] }), 'fill this in', []).replace(
      /\s+/g,
      ' ',
    );
    expect(text).toMatch(/LOCAL VALUE HANDLES: none/i);
    expect(text).toMatch(/no token to copy and no token to invent/i);
    expect(text).toMatch(/request_user_input/);
  });

  it('carries no secret value', () => {
    const text = pageMessage(packet(), 'log in', []);
    expect(text).not.toContain(AADHAAR);
  });

  it('keeps only the recent history so the current page is not crowded out', () => {
    const history = Array.from({ length: 30 }, (_, i) => `step ${String(i)}: did a thing`);
    const text = pageMessage(packet(), 'task', history);
    expect(text).toContain('step 29');
    expect(text).not.toContain('step 5:');
  });

  it('flags a field whose label and attributes disagree', () => {
    const suspicious = packet({
      nodes: [
        {
          id: 'el_9',
          role: 'textbox',
          name: 'Search',
          rect: [0, 0, 100, 20],
          interactive: true,
          editable: true,
          suspect: true,
        },
      ],
    });
    expect(pageMessage(suspicious, 'task', [])).toContain('SUSPECT');
  });
});

describe('buildMessages', () => {
  it('sends text only when there is no screenshot', () => {
    const messages = buildMessages({
      packet: packet(),
      task: 't',
      history: [],
      currentUrl: 'https://portal.example.edu/',
    });
    expect(messages).toHaveLength(2);
    expect(typeof messages[1]?.content).toBe('string');
  });

  it('attaches the screenshot as an image part', () => {
    const messages = buildMessages({
      packet: packet(),
      task: 't',
      history: [],
      currentUrl: 'https://portal.example.edu/',
      screenshot: 'data:image/jpeg;base64,AAAA',
    });
    const content = messages[1]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      expect(content.some((part) => 'type' in part && part.type === 'image_url')).toBe(true);
    }
  });

  /** One system prompt, whether or not a page is readable. */
  it('uses the same system prompt with and without a page', () => {
    const withPage = buildMessages({
      packet: packet(),
      task: 't',
      history: [],
      currentUrl: 'https://portal.example.edu/',
    });
    const withoutPage = buildMessages({
      task: 't',
      history: [],
      unreadable: 'nothing is open',
      currentUrl: 'about:blank',
    });
    expect(withoutPage[0]?.content).toBe(withPage[0]?.content);
  });
});

// ---------------------------------------------------------------------------
// No readable page
//
// This used to be a second prompt with its own rules and a hardcoded search
// engine, which meant the agent behaved like a different agent depending on
// whether a page happened to be loaded. Now the page section is simply absent.
// ---------------------------------------------------------------------------

describe('userMessage with no page', () => {
  it('says what is going on and which moves remain', () => {
    const text = userMessage({
      task: 'open my college portal',
      history: [],
      unreadable: 'this tab is a browser page',
      currentUrl: 'chrome://newtab/',
    });

    expect(text).toContain('open my college portal');
    expect(text).toContain('chrome://newtab/');
    expect(text).toContain('browser page');
    expect(text).toContain('goto_url');
  });

  /**
   * The one request in the system whose privacy properties need no argument: there is
   * no page, so there is nothing from a page to send.
   */
  it('carries nothing from any page', () => {
    const text = userMessage({
      task: 'log in',
      history: ['step 1: opened https://x.test/'],
      unreadable: 'nothing loaded',
      currentUrl: 'about:blank',
    });
    expect(text).not.toContain('el_');
    expect(text).not.toContain('THINGS YOU CAN ACT ON');
    expect(text).not.toContain('VIEWPORT');
  });

  it('includes recent history so the agent does not repeat itself', () => {
    const text = userMessage({
      task: 't',
      history: ['step 1: opened https://a.test/', 'step 2: that was the wrong site'],
      unreadable: 'r',
      currentUrl: 'about:blank',
    });
    expect(text).toContain('wrong site');
  });

  /**
   * Element ids in the history are rewritten, because the model was reading them back out
   * of its own transcript and proposing them again. A live run filled the chat with
   * "Clicking the page" — the narrator's words for an id that resolves to nothing.
   */
  it('expires element ids quoted in the history', () => {
    const text = userMessage({
      task: 'log in',
      history: ['step 3: click el_47 — refused: el_47 is not on the page any more'],
      unreadable: 'nothing is open',
      currentUrl: 'about:blank',
    });

    expect(text).not.toContain('el_47');
    expect(text).toContain('<expired>');
    // The sentence still has to be readable, or the history stops being useful.
    expect(text).toMatch(/click <expired> — refused/);
    expect(text).toMatch(/EXPIRED/);
  });

  /** Which search engine, if any, is the model's call — not a constant in our code. */
  it('names no particular search engine', () => {
    const text = userMessage({
      task: 'search for ipl',
      history: [],
      unreadable: 'nothing is open',
      currentUrl: 'about:blank',
    }).toLowerCase();
    expect(text).not.toContain('duckduckgo');
    expect(text).not.toContain('google.com');
  });
});
