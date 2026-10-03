import { describe, expect, it } from 'vitest';
import { checkSettings, DEFAULT_SETTINGS, hostPatternFor, presetFor } from '@sih/core';
import { parseAction } from '../src/llm/parse.ts';

// ---------------------------------------------------------------------------
// Settings validation
// ---------------------------------------------------------------------------

describe('checkSettings', () => {
  it('rejects an empty configuration with useful reasons', () => {
    const check = checkSettings(DEFAULT_SETTINGS);
    expect(check.ok).toBe(false);
    expect(check.problems).toContain('no_model');
    expect(check.problems).toContain('no_key');
  });

  it('accepts a complete OpenRouter configuration', () => {
    const check = checkSettings({
      ...DEFAULT_SETTINGS,
      model: 'qwen/qwen3-vl-8b-instruct',
      hasKey: true,
    });
    expect(check.ok).toBe(true);
  });

  /**
   * A local server legitimately has no key, so demanding one would block the only
   * fully-offline configuration.
   */
  it('does not demand a key for a local provider', () => {
    const check = checkSettings({
      ...DEFAULT_SETTINGS,
      provider: 'local',
      baseUrl: presetFor('local').baseUrl,
      model: 'qwen2.5vl:7b',
      hasKey: false,
    });
    expect(check.ok).toBe(true);
  });

  /**
   * Plain http to a remote host would put the redacted page and the API key on the
   * wire in clear text. Loopback is the one place it is fine.
   */
  it('allows http only for loopback', () => {
    const remote = checkSettings({
      ...DEFAULT_SETTINGS,
      provider: 'custom',
      baseUrl: 'http://example.com/v1',
      model: 'm',
      hasKey: true,
    });
    expect(remote.problems).toContain('insecure_remote');

    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const local = checkSettings({
        ...DEFAULT_SETTINGS,
        provider: 'custom',
        baseUrl: `http://${host}:11434/v1`,
        model: 'm',
        hasKey: false,
      });
      expect(local.problems, host).not.toContain('insecure_remote');
    }
  });

  it('rejects a malformed URL', () => {
    const check = checkSettings({
      ...DEFAULT_SETTINGS,
      provider: 'custom',
      baseUrl: 'not a url',
      model: 'm',
      hasKey: true,
    });
    expect(check.problems).toContain('bad_base_url');
  });
});

describe('hostPatternFor', () => {
  it('produces a permission match pattern', () => {
    expect(hostPatternFor('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/*');
    expect(hostPatternFor('http://localhost:11434/v1')).toBe('http://localhost:11434/*');
  });

  it('returns undefined for junk', () => {
    expect(hostPatternFor('nonsense')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Reply parsing
// ---------------------------------------------------------------------------

describe('parseAction — tolerating how models actually reply', () => {
  it('parses the documented shape', () => {
    const result = parseAction(
      '{"reasoning":"log in first","action":{"type":"click","target":"el_4"}}',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toEqual({ type: 'click', target: 'el_4' });
      expect(result.reasoning).toBe('log in first');
    }
  });

  it('parses a flattened reply with no action wrapper', () => {
    const result = parseAction('{"type":"click","target":"el_4"}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action.type).toBe('click');
  });

  /**
   * A single action must still report a one-entry batch, because the loop reads
   * `actions` and would otherwise silently do nothing on the overwhelmingly common
   * reply shape.
   */
  it('reports a single action as a batch of one', () => {
    const result = parseAction('{"type":"go_back"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toBe(result.action);
    }
  });

  /**
   * The reason batching exists: a fifteen-field form used to cost fifteen screenshots,
   * fifteen redaction passes and fifteen model calls.
   */
  it('parses a batch of field fills', () => {
    const raw = JSON.stringify({
      reasoning: 'fill the name fields',
      actions: [
        {
          type: 'type',
          target: 'el_1',
          value: { kind: 'placeholder', placeholderId: 'GIVEN_NAME_1' },
        },
        {
          type: 'type',
          target: 'el_2',
          value: { kind: 'placeholder', placeholderId: 'FAMILY_NAME_1' },
        },
        { type: 'type', target: 'el_3', value: 'Pune' },
      ],
    });
    const result = parseAction(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actions).toHaveLength(3);
      expect(result.action.type).toBe('type');
      expect(result.reasoning).toBe('fill the name fields');
    }
  });

  /** Singular key, plural value — models mix the two constantly. */
  it('accepts a list under the singular "action" key', () => {
    const raw =
      '{"action":[{"type":"scroll","direction":"down"},{"type":"hover","target":"el_9"}]}';
    const result = parseAction(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.actions).toHaveLength(2);
  });

  /** A bare array has nowhere to put `reasoning`, and is still unambiguous. */
  it('accepts a bare array with no wrapper object', () => {
    const result = parseAction('[{"type":"hover","target":"el_1"},{"type":"go_back"}]');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actions).toHaveLength(2);
      expect(result.action.type).toBe('hover');
    }
  });

  it('caps an over-long batch rather than refusing it', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      type: 'hover',
      target: `el_${String(i)}`,
    }));
    const result = parseAction(JSON.stringify({ actions: many }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.actions).toHaveLength(8);
  });

  /**
   * A bad entry anywhere fails the whole reply. Executing the good prefix of a plan the
   * model did not finish describing is how an agent ends up half way through a form
   * without knowing it stopped.
   */
  it('refuses the whole batch when one entry is malformed', () => {
    const raw = JSON.stringify({
      actions: [{ type: 'hover', target: 'el_1' }, { type: 'click' }],
    });
    const result = parseAction(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/action 2 of 2/);
      expect(result.error).toMatch(/target/);
    }
  });

  it('refuses an empty batch', () => {
    const result = parseAction('{"actions":[]}');
    expect(result.ok).toBe(false);
  });

  it('strips a markdown code fence', () => {
    const result = parseAction('Here is my step:\n```json\n{"type":"go_back"}\n```\nDone.');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action.type).toBe('go_back');
  });

  /**
   * Brace matching rather than a regex, so nested objects survive. A regex stopping
   * at the first `}` would truncate `{"action":{...}}` and lose the action.
   */
  it('handles nesting when prose surrounds the JSON', () => {
    const raw =
      'I will type it. {"action":{"type":"type","target":"el_7","value":{"kind":"literal","text":"hi"}}} ok?';
    const result = parseAction(raw);
    expect(result.ok).toBe(true);
    if (result.ok && result.action.type === 'type') {
      expect(result.action.value).toEqual({ kind: 'literal', text: 'hi' });
    }
  });

  it('accepts a bare string as a literal value', () => {
    const result = parseAction('{"type":"type","target":"el_7","value":"attendance"}');
    expect(result.ok).toBe(true);
    if (result.ok && result.action.type === 'type') {
      expect(result.action.value).toEqual({ kind: 'literal', text: 'attendance' });
    }
  });

  it('parses a placeholder reference', () => {
    const result = parseAction(
      '{"type":"type","target":"el_7","value":{"kind":"placeholder","placeholderId":"AADHAAR_1"}}',
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.action.type === 'type') {
      expect(result.action.value).toEqual({ kind: 'placeholder', placeholderId: 'AADHAAR_1' });
    }
  });

  it('accepts common aliases for action names', () => {
    for (const [raw, expected] of [
      ['{"type":"fill","target":"el_1","value":"x"}', 'type'],
      ['{"type":"navigate","url":"https://x.test/"}', 'goto_url'],
      ['{"type":"press","keys":"Enter"}', 'key_press'],
      [
        '{"type":"ask_user","category":"otp","reason":"code","placeholderId":"OTP_1"}',
        'request_user_input',
      ],
      ['{"type":"done","answer":"found it"}', 'stop'],
    ] as const) {
      const result = parseAction(raw);
      expect(result.ok, raw).toBe(true);
      if (result.ok) expect(result.action.type).toBe(expected);
    }
  });

  it('normalises an unknown input category rather than failing', () => {
    const result = parseAction(
      '{"type":"request_user_input","category":"weird thing","reason":"r","placeholderId":"X_1"}',
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.action.type === 'request_user_input') {
      expect(result.action.category).toBe('other');
    }
  });
});

describe('parseAction — refusing what it should', () => {
  it('refuses an action type it cannot perform', () => {
    const result = parseAction('{"type":"execute_javascript","code":"alert(1)"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not an action');
  });

  it('refuses a click with no target', () => {
    const result = parseAction('{"type":"click"}');
    expect(result.ok).toBe(false);
  });

  it('refuses a reply containing no JSON', () => {
    const result = parseAction('I think you should click the login button.');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('No JSON');
  });

  it('refuses malformed JSON and says so', () => {
    const result = parseAction('{"type":"click","target":}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not valid JSON');
  });

  it('refuses a value reference with an unknown kind', () => {
    const result = parseAction(
      '{"type":"type","target":"el_1","value":{"kind":"secret","name":"password"}}',
    );
    expect(result.ok).toBe(false);
  });

  /**
   * The error text is fed back to the model on the next turn, so it has to describe
   * the fix rather than just report a failure.
   */
  it('produces an error a model can act on', () => {
    const result = parseAction('{"type":"type","target":"el_1"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(10);
  });
});
