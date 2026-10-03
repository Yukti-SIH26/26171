import { describe, expect, it } from 'vitest';
import {
  EMPTY_FLAGS,
  ELEMENT_GRAPH_SCHEMA_VERSION,
  type ElementGraph,
  type ElementNode,
} from '@sih/core';
import { findPatterns } from '../src/pii/patterns.ts';
import { classifyElement, hasConflictingSignals } from '../src/pii/structural.ts';
import {
  containsKnownValue,
  findKnownValues,
  type KnownValue,
} from '../src/pii/known-values.ts';
import { detectPii } from '../src/pii/detect.ts';

/** Computed-valid fixtures. See checksum.test.ts for how they were derived. */
const AADHAAR = '432187652109';
const AADHAAR_GROUPED = '4321 8765 2109';
const PAN = 'ABCPE1234F';
const GSTIN = '27ABCPE1234F1Z5';

function node(partial: Partial<ElementNode> & { id: string }): ElementNode {
  return {
    role: 'generic',
    name: '',
    rect: { x: 0, y: 0, width: 200, height: 24 },
    source: 'structure',
    confidence: 1,
    flags: { ...EMPTY_FLAGS },
    ...partial,
  };
}

function graphOf(
  nodes: readonly ElementNode[],
  url = 'https://portal.example.edu/profile?roll=123',
): ElementGraph {
  return {
    schemaVersion: ELEMENT_GRAPH_SCHEMA_VERSION,
    url,
    title: 'Student Profile',
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    capturedAt: 1_700_000_000_000,
    nodes,
    stats: {
      structureCount: nodes.length,
      pixelCount: 0,
      fusedCount: 0,
      pixelOnlyCount: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Pattern detector
// ---------------------------------------------------------------------------

describe('findPatterns — checksum gating', () => {
  it('finds a checksum-valid Aadhaar, grouped or not', () => {
    expect(findPatterns(`Aadhaar: ${AADHAAR}`).map((m) => m.piiType)).toContain('aadhaar');
    expect(findPatterns(`Aadhaar: ${AADHAAR_GROUPED}`).map((m) => m.piiType)).toContain(
      'aadhaar',
    );
  });

  /**
   * The single most important precision test in the detector. A bare 12-digit
   * regex would black out order ids and timestamps all over a student portal,
   * and every one of those wasted rectangles is context the remote model loses.
   */
  it('ignores a 12-digit number that fails the checksum', () => {
    const types = findPatterns('Order reference 432187652100 shipped').map((m) => m.piiType);
    expect(types).not.toContain('aadhaar');
  });

  it('ignores a 12-digit timestamp', () => {
    expect(findPatterns('ts=202601011230').map((m) => m.piiType)).not.toContain('aadhaar');
  });

  it('finds a valid PAN and rejects a bad holder-type character', () => {
    expect(findPatterns(`PAN ${PAN}`).map((m) => m.piiType)).toContain('pan');
    expect(findPatterns('PAN ABCZE1234F').map((m) => m.piiType)).not.toContain('pan');
  });
});

describe('findPatterns — overlap resolution', () => {
  /**
   * A GSTIN contains a PAN. Without overlap suppression the same 15 characters
   * produce two findings, the redactor gets two overlapping spans, and the text
   * substitution double-applies and corrupts the placeholder catalogue.
   */
  it('reports a GSTIN once, not also as the PAN inside it', () => {
    const matches = findPatterns(`GSTIN ${GSTIN}`);
    const types = matches.map((m) => m.piiType);
    expect(types).toContain('gstin');
    expect(types).not.toContain('pan');
  });

  it('never returns two findings covering the same characters', () => {
    const matches = findPatterns(
      `Aadhaar ${AADHAAR}, PAN ${PAN}, GSTIN ${GSTIN}, card 4111111111119`,
    );
    for (let i = 0; i < matches.length; i++) {
      for (let j = i + 1; j < matches.length; j++) {
        const a = matches[i];
        const b = matches[j];
        if (a === undefined || b === undefined) continue;
        expect(a.start < b.end && b.start < a.end, `${a.piiType} overlaps ${b.piiType}`).toBe(
          false,
        );
      }
    }
  });
});

describe('findPatterns — context requirement', () => {
  /**
   * A 6-digit number is nothing on its own. It is an OTP only because the text
   * around it says so, which is why these rules are context-gated rather than
   * shape-gated.
   */
  it('finds an OTP only when the surrounding text says so', () => {
    expect(findPatterns('Your OTP is 483920').map((m) => m.piiType)).toContain('otp');
    expect(findPatterns('Room 483920 on floor 2').map((m) => m.piiType)).not.toContain('otp');
  });

  it('accepts context supplied separately from the value', () => {
    // How a bare <input value="483920"> gets classified by its label.
    expect(
      findPatterns('483920', 'Enter the OTP sent to your phone').map((m) => m.piiType),
    ).toContain('otp');
    expect(findPatterns('483920', 'Seat number').map((m) => m.piiType)).not.toContain('otp');
  });

  it('finds a date of birth only in a birth context', () => {
    expect(findPatterns('DOB: 14/08/2003').map((m) => m.piiType)).toContain('date_of_birth');
    expect(findPatterns('Due 14/08/2003').map((m) => m.piiType)).not.toContain('date_of_birth');
  });
});

describe('findPatterns — high-entropy secrets', () => {
  it('finds vendor-prefixed API keys', () => {
    expect(findPatterns('key=sk_live_abcdefghij0123456789').map((m) => m.piiType)).toContain(
      'api_key',
    );
    expect(findPatterns('AKIAIOSFODNN7EXAMPLE').map((m) => m.piiType)).toContain('api_key');
  });

  it('finds a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p';
    expect(findPatterns(jwt).map((m) => m.piiType)).toContain('secret_token');
  });

  /**
   * "Long random string" would match minified asset hashes across a real page.
   * Requiring a known prefix is what keeps this rule usable.
   */
  it('does not treat an asset hash as a secret', () => {
    const types = findPatterns('/static/app.4f3a9c2e1b8d7f6a5c4b3a2918.js').map(
      (m) => m.piiType,
    );
    expect(types).not.toContain('api_key');
    expect(types).not.toContain('secret_token');
  });
});

describe('findPatterns — robustness', () => {
  it('returns nothing for empty input', () => {
    expect(findPatterns('')).toEqual([]);
  });

  it('is deterministic across repeated calls', () => {
    // Guards against a shared regex `lastIndex` leaking between invocations.
    const text = `Aadhaar ${AADHAAR} and PAN ${PAN}`;
    const first = findPatterns(text);
    const second = findPatterns(text);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// Structural detector
// ---------------------------------------------------------------------------

describe('classifyElement', () => {
  it('treats input[type=password] as near-certain', () => {
    const findings = classifyElement(node({ id: 'el_1', tag: 'input', inputType: 'password' }));
    const password = findings.find((f) => f.piiType === 'password');
    expect(password).toBeDefined();
    expect(password?.confidence).toBeGreaterThanOrEqual(0.99);
  });

  it('reads the autocomplete vocabulary, including prefixed values', () => {
    expect(
      classifyElement(node({ id: 'el_2', autocomplete: 'cc-number' })).map((f) => f.piiType),
    ).toContain('credit_card');
    expect(
      classifyElement(
        node({ id: 'el_3', autocomplete: 'section-a billing street-address' }),
      ).map((f) => f.piiType),
    ).toContain('address');
  });

  it('ignores autocomplete=off', () => {
    expect(classifyElement(node({ id: 'el_4', autocomplete: 'off' }))).toEqual([]);
  });

  /**
   * Fires on an empty field, which the pattern layer cannot do. This is what lets
   * the agent know a box is a password box before there is any value in it.
   */
  it('classifies an empty field from its label alone', () => {
    const findings = classifyElement(
      node({ id: 'el_5', name: 'Aadhaar Number', flags: { ...EMPTY_FLAGS, editable: true } }),
    );
    expect(findings.map((f) => f.piiType)).toContain('aadhaar');
  });

  /**
   * The attribute name is often more literal about a field's contents than the
   * label shown to the user.
   */
  it('uses the form control name when the visible label is vague', () => {
    const findings = classifyElement(
      node({ id: 'el_6', name: 'Enter number', fieldName: 'txtAadharNo' }),
    );
    expect(findings.map((f) => f.piiType)).toContain('aadhaar');
  });

  it('emits at most one label signal per element', () => {
    const findings = classifyElement(
      node({ id: 'el_7', name: 'Card number / account number' }),
    );
    expect(findings.filter((f) => f.evidence.startsWith('label:')).length).toBe(1);
  });
});

describe('hasConflictingSignals', () => {
  /**
   * The bait-field attack: a box labelled "Search" but marked as a card number
   * field, hoping an automated agent types a card number into it.
   */
  it('flags a field whose attribute and label disagree', () => {
    const findings = classifyElement(
      node({ id: 'el_8', autocomplete: 'cc-number', name: 'Search the site' }),
    );
    expect(hasConflictingSignals(findings)).toBe(false); // "Search" matches no label rule

    const baited = classifyElement(
      node({ id: 'el_9', autocomplete: 'cc-number', name: 'Email address' }),
    );
    expect(hasConflictingSignals(baited)).toBe(true);
  });

  it('does not flag agreement', () => {
    const findings = classifyElement(
      node({ id: 'el_10', autocomplete: 'cc-number', name: 'Card Number' }),
    );
    expect(hasConflictingSignals(findings)).toBe(false);
  });

  it('does not flag a single-source signal', () => {
    expect(
      hasConflictingSignals(classifyElement(node({ id: 'el_11', name: 'Password' }))),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Known-value detector
// ---------------------------------------------------------------------------

const VAULT: readonly KnownValue[] = [
  { piiType: 'aadhaar', value: AADHAAR, slot: 'primary' },
  { piiType: 'person_name', value: 'Ramesh Kumar', slot: 'self' },
];

describe('findKnownValues', () => {
  /**
   * The vault is filled in once, in one format, but a page renders whichever
   * format it likes. Without separator tolerance this layer would miss most real
   * pages.
   */
  it('matches a vault value regardless of how the page formats it', () => {
    for (const rendered of [AADHAAR, '4321 8765 2109', '4321-8765-2109']) {
      const matches = findKnownValues(`ID ${rendered}`, VAULT);
      expect(
        matches.map((m) => m.piiType),
        rendered,
      ).toContain('aadhaar');
    }
  });

  it('reports offsets into the original string, not a normalised copy', () => {
    const text = `ID ${AADHAAR_GROUPED} end`;
    const match = findKnownValues(text, VAULT).find((m) => m.piiType === 'aadhaar');
    expect(match).toBeDefined();
    expect(text.slice(match?.start ?? 0, match?.end ?? 0)).toBe(AADHAAR_GROUPED);
  });

  it('is certain, because the user asserted the value', () => {
    expect(findKnownValues(AADHAAR, VAULT)[0]?.confidence).toBe(1);
  });

  it('respects word boundaries for name-like values', () => {
    expect(findKnownValues('Ramesh Kumaravel', VAULT).map((m) => m.piiType)).not.toContain(
      'person_name',
    );
    expect(findKnownValues('by Ramesh Kumar today', VAULT).map((m) => m.piiType)).toContain(
      'person_name',
    );
  });

  /**
   * A two-character vault entry would match constantly and black out the page.
   * The floor trades a little recall for a usable redaction budget.
   */
  it('ignores vault entries too short to be distinctive', () => {
    const short: readonly KnownValue[] = [{ piiType: 'person_name', value: 'Al', slot: 'x' }];
    expect(findKnownValues('Also all along', short)).toEqual([]);
  });

  it('prefers the longer match when two overlap', () => {
    const vault: readonly KnownValue[] = [
      { piiType: 'address', value: '12 Nehru Road, Pune', slot: 'home' },
      { piiType: 'address', value: 'Nehru Road', slot: 'street' },
    ];
    const matches = findKnownValues('Lives at 12 Nehru Road, Pune now', vault);
    expect(matches.length).toBe(1);
    expect(matches[0]?.slot).toBe('home');
  });

  it('returns nothing for an empty vault', () => {
    expect(findKnownValues(AADHAAR, [])).toEqual([]);
  });
});

describe('containsKnownValue', () => {
  it('detects a secret anywhere in a blob of text', () => {
    expect(containsKnownValue(`{"x":"${AADHAAR}"}`, VAULT)).toBe(true);
    expect(containsKnownValue('{"x":"nothing here"}', VAULT)).toBe(false);
  });

  it('sees through separator formatting', () => {
    expect(containsKnownValue(`{"x":"4321-8765-2109"}`, VAULT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

describe('detectPii', () => {
  it('fuses detectors by maximum, not average', () => {
    // A password field with a weak label: input[type=password] is 0.99 and must
    // not be dragged down by anything weaker agreeing.
    const graph = graphOf([
      node({
        id: 'el_1',
        tag: 'input',
        inputType: 'password',
        name: 'PIN',
        flags: { ...EMPTY_FLAGS, editable: true, interactive: true },
      }),
    ]);
    const { findings } = detectPii({ graph });
    const password = findings.find((f) => f.piiType === 'password');
    expect(password?.confidence).toBeGreaterThanOrEqual(0.99);
    expect(password?.detectors).toContain('structural');
  });

  it('records which detectors agreed on the same value', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        name: 'Aadhaar Number',
        text: AADHAAR,
        rect: { x: 0, y: 0, width: 160, height: 20 },
      }),
    ]);
    const { findings } = detectPii({ graph, vault: VAULT });
    const aadhaar = findings.find((f) => f.piiType === 'aadhaar' && f.span !== undefined);
    expect(aadhaar?.detectors).toEqual(expect.arrayContaining(['known_value', 'pattern']));
  });

  /**
   * The threshold gradient in action: a password is redacted on the faintest
   * signal, a person's name demands real evidence. Over-redacting names would
   * strip the page of the context the remote model needs.
   */
  /**
   * This assertion used to run the other way: "Full Name" scored 0.65 against a 0.75
   * threshold, so it was deliberately left visible on the theory that over-redacting
   * names starves the model of context. In a live run that meant a filled enrolment form
   * sent the user's first name, last name and full name out in the clear, while the
   * Aadhaar number beside them was masked.
   *
   * A label is not a guess about what a field holds — it is the page stating it. So an
   * explicit name label is covered, and a box that says nothing about itself is still
   * left alone.
   */
  it('covers a field the page labels as a name, and leaves an unlabelled box alone', () => {
    const NAME_TYPES = new Set(['person_name', 'given_name', 'family_name']);
    for (const label of ['Full Name', 'First Name', 'Last Name']) {
      const { findings } = detectPii({ graph: graphOf([node({ id: 'el_1', name: label })]) });
      expect(
        findings.find((f) => NAME_TYPES.has(f.piiType)),
        label,
      ).toBeDefined();
    }

    const { findings: anonymous } = detectPii({
      graph: graphOf([node({ id: 'el_2', name: 'Search' })]),
    });
    expect(anonymous.find((f) => NAME_TYPES.has(f.piiType))).toBeUndefined();
  });

  /**
   * First and last name are distinct types, not both `person_name`.
   *
   * When they collapsed, a form with First Name and Last Name boxes offered the agent a
   * single handle for both and it typed the full name into each — which is exactly what a
   * live run produced, with "krishna Agrawal" in both fields.
   */
  it('tells a first name apart from a last name', () => {
    const given = detectPii({ graph: graphOf([node({ id: 'el_1', name: 'First Name' })]) });
    expect(given.findings.some((f) => f.piiType === 'given_name')).toBe(true);
    expect(given.findings.some((f) => f.piiType === 'family_name')).toBe(false);

    const family = detectPii({ graph: graphOf([node({ id: 'el_1', name: 'Last Name' })]) });
    expect(family.findings.some((f) => f.piiType === 'family_name')).toBe(true);
    expect(family.findings.some((f) => f.piiType === 'given_name')).toBe(false);

    // The whole name keeps its own type, so a "Full Name" box is still distinguishable
    // from either part.
    const whole = detectPii({ graph: graphOf([node({ id: 'el_1', name: 'Full Name' })]) });
    expect(whole.findings.some((f) => f.piiType === 'person_name')).toBe(true);
  });

  /** `autocomplete` is the page stating it outright, and it must not collapse either. */
  it('reads given-name and family-name out of autocomplete', () => {
    const given = detectPii({
      graph: graphOf([node({ id: 'el_1', tag: 'input', autocomplete: 'given-name' })]),
    });
    expect(given.findings.some((f) => f.piiType === 'given_name')).toBe(true);

    const family = detectPii({
      graph: graphOf([node({ id: 'el_1', tag: 'input', autocomplete: 'family-name' })]),
    });
    expect(family.findings.some((f) => f.piiType === 'family_name')).toBe(true);
  });

  it('gives every finding a usable rectangle', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        name: 'Aadhaar',
        text: `ID ${AADHAAR}`,
        rect: { x: 10, y: 20, width: 300, height: 24 },
      }),
      node({
        id: 'el_2',
        tag: 'input',
        inputType: 'password',
        flags: { ...EMPTY_FLAGS, editable: true },
      }),
    ]);
    const { findings } = detectPii({ graph, vault: VAULT });
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.rect.width, finding.piiType).toBeGreaterThan(0);
      expect(finding.rect.height, finding.piiType).toBeGreaterThan(0);
    }
  });

  it('keeps a span rectangle inside its element', () => {
    const rect = { x: 10, y: 20, width: 300, height: 24 };
    const graph = graphOf([
      node({ id: 'el_1', name: 'Aadhaar', text: `ID ${AADHAAR} ok`, rect }),
    ]);
    const { findings } = detectPii({ graph, vault: VAULT });
    const spanned = findings.find((f) => f.span !== undefined);
    expect(spanned).toBeDefined();
    expect(spanned?.rect.x).toBeGreaterThanOrEqual(rect.x);
    expect((spanned?.rect.x ?? 0) + (spanned?.rect.width ?? 0)).toBeLessThanOrEqual(
      rect.x + rect.width,
    );
  });

  it('scans OCR words that belong to no element', () => {
    const graph = graphOf([]);
    const { findings } = detectPii({
      graph,
      words: [{ text: AADHAAR, rect: { x: 5, y: 5, width: 120, height: 14 }, confidence: 0.9 }],
      vault: VAULT,
    });
    expect(findings.map((f) => f.piiType)).toContain('aadhaar');
  });

  /**
   * OCR can misread a digit, and a misread digit fails the checksum. Folding
   * recognition confidence in keeps a shaky read from being treated as a
   * certainty.
   */
  it('discounts pattern confidence by OCR recognition confidence', () => {
    const graph = graphOf([]);
    const good = detectPii({
      graph,
      words: [
        {
          text: `Aadhaar ${AADHAAR}`,
          rect: { x: 0, y: 0, width: 200, height: 14 },
          confidence: 1,
        },
      ],
    });
    const shaky = detectPii({
      graph,
      words: [
        {
          text: `Aadhaar ${AADHAAR}`,
          rect: { x: 0, y: 0, width: 200, height: 14 },
          confidence: 0.5,
        },
      ],
    });
    const a = good.findings.find((f) => f.piiType === 'aadhaar')?.confidence ?? 0;
    const b = shaky.findings.find((f) => f.piiType === 'aadhaar')?.confidence ?? 0;
    expect(a).toBeGreaterThan(b);
  });

  it('surfaces a conflicting field rather than silently picking a winner', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        autocomplete: 'cc-number',
        name: 'Email address',
        flags: { ...EMPTY_FLAGS, editable: true },
      }),
    ]);
    const { findings, stats } = detectPii({ graph });
    expect(stats.conflicts).toBe(1);
    expect(findings.some((f) => f.conflicting === true)).toBe(true);
  });

  /**
   * `resolveRedactionMode` must downgrade a blur request to a solid mask for
   * high-value types. Blur is partially reversible on structured text.
   */
  it('never assigns blur to a text secret', () => {
    const graph = graphOf([
      node({ id: 'el_1', name: 'Aadhaar', text: AADHAAR }),
      node({
        id: 'el_2',
        tag: 'input',
        inputType: 'password',
        flags: { ...EMPTY_FLAGS, editable: true },
      }),
    ]);
    const { findings } = detectPii({ graph, vault: VAULT });
    for (const finding of findings) {
      if (finding.piiType === 'face') continue;
      expect(finding.redaction, finding.piiType).not.toBe('blur');
    }
  });

  it('handles an empty graph without throwing', () => {
    const { findings, stats } = detectPii({ graph: graphOf([]) });
    expect(findings).toEqual([]);
    expect(stats.elementsScanned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Coverage of the surfaces that are actually transmitted
//
// The detector used to scan `value`, `text`, and OCR output only, while the egress
// packet transmitted the accessible name. So a value in an `aria-label`, an `alt`, or
// a button label was never looked at and went out verbatim — and since Google puts the
// signed-in account's email in exactly that place, the leak canary aborted the agent on
// the second step of every task.
// ---------------------------------------------------------------------------

describe('detectPii — transmitted surfaces', () => {
  it('finds a secret in the accessible name', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        name: `Google Account: Asha Rao (${AADHAAR})`,
        rect: { x: 0, y: 0, width: 240, height: 32 },
      }),
    ]);
    const { findings } = detectPii({ graph, vault: VAULT });

    const hit = findings.find((f) => f.piiType === 'aadhaar' && f.field === 'name');
    expect(hit).toBeDefined();
    expect(hit?.elementId).toBe('el_1');
    expect(hit?.matchedText).toBe(AADHAAR);
  });

  /**
   * A placeholder often shows a real example value and is rendered on screen, so it
   * needs a rectangle even though it is not part of the outbound text.
   */
  it('finds a secret in a placeholder', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        name: 'Aadhaar',
        placeholder: `e.g. ${AADHAAR}`,
        tag: 'input',
        flags: { ...EMPTY_FLAGS, editable: true },
      }),
    ]);
    const { findings } = detectPii({ graph, vault: VAULT });
    expect(findings.some((f) => f.field === 'placeholder')).toBe(true);
  });

  /**
   * An `aria-label` frequently differs from what is drawn, so interpolating a
   * character span across the element's width would put the box in the wrong place.
   * Covering the whole element is the safe over-estimate.
   */
  it('covers the whole element for a name match', () => {
    const rect = { x: 12, y: 40, width: 300, height: 28 };
    const graph = graphOf([node({ id: 'el_1', name: `ID ${AADHAAR}`, rect })]);
    const { findings } = detectPii({ graph, vault: VAULT });

    const hit = findings.find((f) => f.field === 'name');
    expect(hit?.rect).toEqual(rect);
  });

  /**
   * The same offsets in two different strings are two different places. Without the
   * field in the bucket key they would merge, and only one of the two would ever be
   * rewritten.
   */
  it('keeps a name match and a text match separate', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        name: AADHAAR,
        text: AADHAAR,
        rect: { x: 0, y: 0, width: 200, height: 20 },
      }),
    ]);
    const { findings } = detectPii({ graph, vault: VAULT });

    const fields = findings.filter((f) => f.piiType === 'aadhaar').map((f) => f.field);
    expect(fields).toContain('name');
    expect(fields).toContain('text');
  });
});

// ---------------------------------------------------------------------------
// Value propagation
// ---------------------------------------------------------------------------

describe('detectPii — value propagation', () => {
  /**
   * Detection is per-location, but a value is a value. A portal shows the same roll
   * number in a header, a sidebar, and every table row; the pattern layer may only
   * fire on the one that had a recognisable label next to it, leaving the rest visible
   * in the screenshot.
   */
  it('covers every occurrence once any layer confirms the value', () => {
    const graph = graphOf([
      node({ id: 'el_1', name: 'Aadhaar Number', text: AADHAAR }),
      node({ id: 'el_2', text: AADHAAR, rect: { x: 0, y: 60, width: 160, height: 20 } }),
      node({ id: 'el_3', text: AADHAAR, rect: { x: 0, y: 90, width: 160, height: 20 } }),
    ]);
    const { findings } = detectPii({ graph });

    const elements = new Set(
      findings.filter((f) => f.piiType === 'aadhaar').map((f) => f.elementId),
    );
    expect(elements).toEqual(new Set(['el_1', 'el_2', 'el_3']));
  });

  /**
   * Confidence carries over rather than being reset. The evidence is that this exact
   * literal is an Aadhaar number, and that does not weaken because the literal turned
   * up again — resetting it would push the copies below their policy threshold and
   * leave them visible, which is the whole problem this solves.
   */
  it('carries confidence to the copies so they clear their threshold', () => {
    const graph = graphOf([
      node({ id: 'el_1', name: 'Aadhaar Number', text: AADHAAR }),
      node({ id: 'el_2', text: AADHAAR, rect: { x: 0, y: 60, width: 160, height: 20 } }),
    ]);
    const { findings } = detectPii({ graph });

    const copy = findings.find((f) => f.elementId === 'el_2' && f.piiType === 'aadhaar');
    expect(copy).toBeDefined();
    // 0.35 is the aadhaar threshold. A copy that scored below it would be dropped by
    // the policy gate and left visible, which is exactly what propagation is for.
    expect(copy?.confidence).toBeGreaterThanOrEqual(0.35);
  });

  it('reaches a copy sitting in an accessible name', () => {
    const graph = graphOf([
      node({ id: 'el_1', name: 'Aadhaar Number', text: AADHAAR }),
      node({
        id: 'el_2',
        name: `Copy of ${AADHAAR}`,
        rect: { x: 0, y: 60, width: 200, height: 20 },
      }),
    ]);
    const { findings } = detectPii({ graph });

    expect(
      findings.some(
        (f) => f.elementId === 'el_2' && f.field === 'name' && f.piiType === 'aadhaar',
      ),
    ).toBe(true);
  });

  /** A value never counts itself: propagation skips locations already bucketed. */
  it('does not duplicate the finding it started from', () => {
    const graph = graphOf([node({ id: 'el_1', name: 'Aadhaar Number', text: AADHAAR })]);
    const { findings } = detectPii({ graph });

    const spans = findings
      .filter((f) => f.piiType === 'aadhaar' && f.elementId === 'el_1' && f.field === 'text')
      .map((f) => `${String(f.span?.start)}:${String(f.span?.end)}`);
    expect(new Set(spans).size).toBe(spans.length);
  });

  /**
   * Short values are not propagated. A three-character literal would match inside
   * half the words on the page and black out the screen.
   */
  it('does not propagate a value below the search floor', () => {
    const graph = graphOf([
      node({ id: 'el_1', name: 'Name', text: 'Ram' }),
      node({
        id: 'el_2',
        text: 'Rampur Junction',
        rect: { x: 0, y: 60, width: 200, height: 20 },
      }),
    ]);
    const { findings } = detectPii({
      graph,
      vault: [{ piiType: 'person_name', value: 'Ram', slot: 'short' }],
    });

    expect(findings.some((f) => f.elementId === 'el_2')).toBe(false);
  });
});
