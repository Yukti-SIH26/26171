import { describe, expect, it } from 'vitest';
import {
  ALL_ACTION_TYPES,
  allow,
  emptyCatalogue,
  isTerminal,
  lookupPlaceholder,
  mutatesPage,
  placeholderRefOf,
  refuse,
  targetOf,
  type AgentAction,
  type PlaceholderCatalogue,
} from '../src/action.ts';
import { isElementId } from '../src/element.ts';

describe('action taxonomy', () => {
  it('lists every action type exactly once', () => {
    expect(new Set(ALL_ACTION_TYPES).size).toBe(ALL_ACTION_TYPES.length);
  });

  it('identifies terminal actions', () => {
    expect(isTerminal({ type: 'stop', answer: 'done' })).toBe(true);
    expect(isTerminal({ type: 'click', target: 'el_1' })).toBe(false);
    expect(isTerminal({ type: 'noop' })).toBe(false);
  });

  it('identifies page-mutating actions', () => {
    expect(mutatesPage({ type: 'click', target: 'el_1' })).toBe(true);
    expect(mutatesPage({ type: 'click_point', point: { x: 5, y: 5 } })).toBe(true);
    expect(
      mutatesPage({ type: 'type', target: 'el_1', value: { kind: 'literal', text: 'hi' } }),
    ).toBe(true);
    expect(mutatesPage({ type: 'key_press', keys: 'Enter' })).toBe(true);

    expect(mutatesPage({ type: 'scroll', direction: 'down' })).toBe(false);
    expect(mutatesPage({ type: 'hover', target: 'el_1' })).toBe(false);
    expect(mutatesPage({ type: 'stop', answer: 'x' })).toBe(false);
    expect(mutatesPage({ type: 'noop' })).toBe(false);
  });

  it('extracts the element target when there is one', () => {
    expect(targetOf({ type: 'click', target: 'el_7' })).toBe('el_7');
    expect(targetOf({ type: 'hover', target: 'el_3' })).toBe('el_3');
    expect(targetOf({ type: 'scroll', direction: 'down' })).toBeUndefined();
    expect(targetOf({ type: 'click_point', point: { x: 1, y: 2 } })).toBeUndefined();
    expect(targetOf({ type: 'stop', answer: 'x' })).toBeUndefined();
  });
});

describe('value references keep secrets off the wire', () => {
  it('reports the placeholder a type action needs resolved', () => {
    const action: AgentAction = {
      type: 'type',
      target: 'el_7',
      value: { kind: 'placeholder', placeholderId: 'AADHAAR_1' },
    };
    expect(placeholderRefOf(action)).toBe('AADHAAR_1');
  });

  it('reports nothing for a literal value', () => {
    const action: AgentAction = {
      type: 'type',
      target: 'el_2',
      value: { kind: 'literal', text: 'attendance' },
    };
    expect(placeholderRefOf(action)).toBeUndefined();
  });

  it('resolves placeholders in select options too', () => {
    const action: AgentAction = {
      type: 'select',
      target: 'el_9',
      option: { kind: 'placeholder', placeholderId: 'DOB_1' },
    };
    expect(placeholderRefOf(action)).toBe('DOB_1');
  });

  it('reports nothing for actions that carry no value', () => {
    expect(placeholderRefOf({ type: 'click', target: 'el_1' })).toBeUndefined();
    expect(placeholderRefOf({ type: 'go_back' })).toBeUndefined();
  });
});

describe('placeholder catalogue', () => {
  const catalogue: PlaceholderCatalogue = {
    schemaVersion: 1,
    entries: [
      {
        placeholderId: 'AADHAAR_1',
        piiType: 'aadhaar',
        description: '12-digit Aadhaar number',
        available: true,
        occurrences: 2,
      },
      {
        placeholderId: 'OTP_1',
        piiType: 'otp',
        description: '6-digit one-time password',
        available: false,
        occurrences: 1,
      },
    ],
  };

  it('starts empty', () => {
    expect(emptyCatalogue().entries).toHaveLength(0);
  });

  it('looks entries up by id', () => {
    expect(lookupPlaceholder(catalogue, 'AADHAAR_1')?.piiType).toBe('aadhaar');
    expect(lookupPlaceholder(catalogue, 'NOPE_1')).toBeUndefined();
  });

  it('marks values the client cannot supply as unavailable', () => {
    // An OTP is unavailable by construction: it has to be asked for, which is
    // what drives the request_user_input path instead of a silent failure.
    expect(lookupPlaceholder(catalogue, 'OTP_1')?.available).toBe(false);
  });

  it('carries only shape, never a real value', () => {
    // Guards the central privacy claim: a leak here would ship PII to the
    // server inside the very structure meant to prevent that.
    const serialized = JSON.stringify(catalogue);
    expect(serialized).not.toMatch(/\d{12}/);
    for (const entry of catalogue.entries) {
      expect(Object.keys(entry).sort()).toEqual([
        'available',
        'description',
        'occurrences',
        'piiType',
        'placeholderId',
      ]);
    }
  });
});

describe('validation verdicts', () => {
  it('allows', () => {
    expect(allow()).toEqual({ ok: true });
  });

  it('refuses with a machine-readable code and a human-readable detail', () => {
    const verdict = refuse('obscured', 'another element covers the centre point');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe('obscured');
      expect(verdict.detail).toContain('covers');
    }
  });
});

describe('element id format', () => {
  it('accepts generated ids and rejects anything else', () => {
    expect(isElementId('el_0')).toBe(true);
    expect(isElementId('el_412')).toBe(true);
    expect(isElementId('el_')).toBe(false);
    expect(isElementId('button#submit')).toBe(false);
    expect(isElementId('')).toBe(false);
    expect(isElementId(undefined)).toBe(false);
  });
});
