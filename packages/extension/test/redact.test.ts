import { describe, expect, it } from 'vitest';
import {
  EMPTY_FLAGS,
  ELEMENT_GRAPH_SCHEMA_VERSION,
  type ElementGraph,
  type ElementNode,
  type ViewportInfo,
} from '@sih/core';
import {
  HEAVY_COVERAGE,
  REFUSE_COVERAGE,
  placeholderFor,
  planRedaction,
  syntheticFor,
} from '../src/redact/plan.ts';
import { buildEgressPacket } from '../src/redact/packet.ts';
import type { PiiFinding } from '../src/pii/detect.ts';
import type { KnownValue } from '../src/pii/known-values.ts';

const AADHAAR = '432187652109';

const VIEWPORT: ViewportInfo = {
  width: 1000,
  height: 800,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 1,
};

const BOUNDS = { x: 0, y: 0, width: 1000, height: 800 };

function finding(partial: Partial<PiiFinding> & { id: string }): PiiFinding {
  return {
    piiType: 'aadhaar',
    confidence: 0.96,
    redaction: 'placeholder',
    rect: { x: 10, y: 10, width: 100, height: 20 },
    detectors: ['pattern'],
    ...partial,
  };
}

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
  url = 'https://portal.example.edu/p?roll=BT21CS042',
): ElementGraph {
  return {
    schemaVersion: ELEMENT_GRAPH_SCHEMA_VERSION,
    url,
    title: 'Profile',
    viewport: VIEWPORT,
    capturedAt: 1_700_000_000_000,
    nodes,
    stats: { structureCount: nodes.length, pixelCount: 0, fusedCount: 0, pixelOnlyCount: 0 },
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

describe('planRedaction — geometry', () => {
  it('pads regions outwards so no sliver of a glyph survives', () => {
    const plan = planRedaction({
      findings: [finding({ id: 'f1', rect: { x: 100, y: 100, width: 50, height: 20 } })],
      viewport: VIEWPORT,
      bounds: BOUNDS,
    });
    const paint = plan.paints[0];
    expect(paint).toBeDefined();
    expect(paint?.rect.x).toBeLessThan(100);
    expect(paint?.rect.width).toBeGreaterThan(50);
  });

  it('clips regions to the captured frame', () => {
    const plan = planRedaction({
      findings: [finding({ id: 'f1', rect: { x: 960, y: 780, width: 200, height: 200 } })],
      viewport: VIEWPORT,
      bounds: BOUNDS,
    });
    const paint = plan.paints[0];
    expect(paint).toBeDefined();
    expect((paint?.rect.x ?? 0) + (paint?.rect.width ?? 0)).toBeLessThanOrEqual(BOUNDS.width);
    expect((paint?.rect.y ?? 0) + (paint?.rect.height ?? 0)).toBeLessThanOrEqual(BOUNDS.height);
  });

  it('counts an entirely off-screen finding as skipped, not painted', () => {
    const plan = planRedaction({
      findings: [finding({ id: 'f1', rect: { x: 5000, y: 5000, width: 50, height: 20 } })],
      viewport: VIEWPORT,
      bounds: BOUNDS,
    });
    expect(plan.paints.length).toBe(0);
    expect(plan.skipped).toBe(1);
  });

  it('merges adjacent regions of the same mode', () => {
    const plan = planRedaction({
      findings: [
        finding({
          id: 'f1',
          redaction: 'mask_solid',
          rect: { x: 10, y: 10, width: 50, height: 20 },
        }),
        finding({
          id: 'f2',
          redaction: 'mask_solid',
          rect: { x: 62, y: 10, width: 50, height: 20 },
        }),
      ],
      viewport: VIEWPORT,
      bounds: BOUNDS,
    });
    expect(plan.paints.length).toBe(1);
    expect(plan.paints[0]?.piiTypes.length).toBeGreaterThan(0);
  });

  /**
   * Merging a blur into a solid mask would needlessly black out a face; merging
   * the other way would be a real downgrade. So modes stay separate.
   */
  it('does not merge across redaction modes', () => {
    const plan = planRedaction({
      findings: [
        finding({
          id: 'f1',
          redaction: 'mask_solid',
          rect: { x: 10, y: 10, width: 50, height: 20 },
        }),
        finding({
          id: 'f2',
          piiType: 'face',
          redaction: 'blur',
          rect: { x: 12, y: 12, width: 50, height: 20 },
        }),
      ],
      viewport: VIEWPORT,
      bounds: BOUNDS,
    });
    expect(plan.paints.length).toBe(2);
  });

  it('ignores findings whose policy is none', () => {
    const plan = planRedaction({
      findings: [finding({ id: 'f1', redaction: 'none' })],
      viewport: VIEWPORT,
      bounds: BOUNDS,
    });
    expect(plan.paints.length).toBe(0);
    expect(plan.skipped).toBe(0);
  });
});

describe('planRedaction — coverage budget', () => {
  /**
   * Coverage must union overlapping rectangles, not sum them. Summing would
   * overstate coverage and could refuse to send a page that is actually fine.
   */
  it('does not double-count overlapping regions', () => {
    const rect = { x: 0, y: 0, width: 500, height: 400 };
    const plan = planRedaction({
      findings: [
        finding({ id: 'f1', redaction: 'mask_solid', rect }),
        finding({ id: 'f2', redaction: 'mask_solid', rect }),
        finding({ id: 'f3', redaction: 'mask_solid', rect }),
      ],
      viewport: VIEWPORT,
      bounds: BOUNDS,
    });
    // One 500x400 box in an 800x1000 viewport is 25%, not 75%.
    expect(plan.coverage).toBeLessThan(0.3);
  });

  it('reports ok for a lightly redacted page', () => {
    const plan = planRedaction({
      findings: [finding({ id: 'f1', rect: { x: 10, y: 10, width: 100, height: 20 } })],
      viewport: VIEWPORT,
      bounds: BOUNDS,
    });
    expect(plan.verdict).toBe('ok');
    expect(plan.reason).toBeUndefined();
  });

  it('flags a heavily redacted page without refusing it', () => {
    const plan = planRedaction({
      findings: [
        finding({
          id: 'f1',
          redaction: 'mask_solid',
          rect: { x: 0, y: 0, width: 1000, height: 300 },
        }),
      ],
      viewport: VIEWPORT,
      bounds: BOUNDS,
    });
    expect(plan.coverage).toBeGreaterThanOrEqual(HEAVY_COVERAGE);
    expect(plan.coverage).toBeLessThan(REFUSE_COVERAGE);
    expect(plan.verdict).toBe('heavy');
    expect(plan.reason).toBeDefined();
  });

  /**
   * Past a point the image carries so little signal that the remote model would
   * be guessing. Refusing is the honest failure mode.
   */
  it('refuses when almost everything would be masked', () => {
    const plan = planRedaction({
      findings: [
        finding({
          id: 'f1',
          redaction: 'mask_solid',
          rect: { x: 0, y: 0, width: 1000, height: 700 },
        }),
      ],
      viewport: VIEWPORT,
      bounds: BOUNDS,
    });
    expect(plan.verdict).toBe('refuse');
    expect(plan.reason).toContain('%');
  });
});

describe('planRedaction — text edits', () => {
  it('emits a placeholder edit for a masked element', () => {
    const plan = planRedaction({
      findings: [
        finding({
          id: 'f1',
          elementId: 'el_1',
          span: { start: 4, end: 16 },
          matchedText: AADHAAR,
        }),
      ],
      viewport: VIEWPORT,
      bounds: BOUNDS,
    });
    expect(plan.edits.length).toBe(1);
    expect(plan.edits[0]?.replacement).toMatch(/^AADHAAR_/);
  });

  /**
   * A value hidden in the picture but present in the accompanying text is not
   * hidden. Off-screen findings must still produce a text edit.
   */
  it('still edits text for a finding with no usable geometry', () => {
    const plan = planRedaction({
      findings: [
        finding({
          id: 'f1',
          elementId: 'el_1',
          rect: { x: 5000, y: 5000, width: 10, height: 10 },
          matchedText: AADHAAR,
        }),
      ],
      viewport: VIEWPORT,
      bounds: BOUNDS,
    });
    expect(plan.paints.length).toBe(0);
    expect(plan.edits.length).toBe(1);
  });

  it('uses a shape-preserving stand-in for synthetic types', () => {
    const plan = planRedaction({
      findings: [
        finding({
          id: 'f1',
          piiType: 'person_name',
          redaction: 'synthetic',
          elementId: 'el_1',
          matchedText: 'Ramesh Kumar',
        }),
      ],
      viewport: VIEWPORT,
      bounds: BOUNDS,
    });
    expect(plan.edits[0]?.replacement).toBe('Xxxxxx Xxxxx');
  });
});

describe('placeholderFor and syntheticFor', () => {
  it('produces a stable, type-revealing token', () => {
    expect(placeholderFor('aadhaar', 'primary', 0)).toBe('AADHAAR_PRIMARY');
    expect(placeholderFor('aadhaar', undefined, 3)).toBe('AADHAAR_3');
  });

  it('preserves length and character class but not content', () => {
    expect(syntheticFor('aadhaar', '4321 8765 2109')).toBe('9999 9999 9999');
    expect(syntheticFor('pan', 'ABCPE1234F')).toBe('XXXXX9999X');
    expect(syntheticFor('person_name', 'Ramesh')).toBe('Xxxxxx');
  });

  it('never returns the original value', () => {
    for (const value of [AADHAAR, 'Ramesh Kumar', 'ABCPE1234F']) {
      expect(syntheticFor('person_name', value)).not.toBe(value);
    }
  });
});

// ---------------------------------------------------------------------------
// Egress packet
// ---------------------------------------------------------------------------

describe('buildEgressPacket — allow-list', () => {
  /**
   * The allow-list property. `value` is the actual content of a field, and it must
   * be structurally impossible for it to reach the packet — not merely stripped.
   */
  it('never emits a field value', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        tag: 'input',
        inputType: 'text',
        name: 'Aadhaar',
        value: AADHAAR,
        flags: { ...EMPTY_FLAGS, editable: true, interactive: true },
      }),
    ]);
    const built = buildEgressPacket({
      graph,
      findings: [],
      plan: { paints: [], edits: [], coverage: 0, verdict: 'ok', skipped: 0 },
    });
    expect(built.json).not.toContain(AADHAAR);
    expect(built.json).not.toContain('"value"');
  });

  it('drops detectorMeta, which carries unredacted OCR text', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        name: 'Card',
        flags: { ...EMPTY_FLAGS, interactive: true },
        detectorMeta: { ocrText: AADHAAR, label: 'a button' },
      }),
    ]);
    const built = buildEgressPacket({
      graph,
      findings: [],
      plan: { paints: [], edits: [], coverage: 0, verdict: 'ok', skipped: 0 },
    });
    expect(built.json).not.toContain(AADHAAR);
    expect(built.json).not.toContain('detectorMeta');
  });

  /**
   * A portal URL routinely carries a roll number or session id in the query
   * string, so the whole path is discarded rather than filtered.
   */
  it('reduces the URL to its origin', () => {
    const built = buildEgressPacket({
      graph: graphOf([], 'https://portal.example.edu/student?roll=BT21CS042&sid=abc'),
      findings: [],
      plan: { paints: [], edits: [], coverage: 0, verdict: 'ok', skipped: 0 },
    });
    expect(built.packet.origin).toBe('https://portal.example.edu');
    expect(built.json).not.toContain('BT21CS042');
  });

  it('withholds hidden nodes entirely', () => {
    const graph = graphOf([
      node({ id: 'el_1', name: 'Visible', flags: { ...EMPTY_FLAGS, interactive: true } }),
      node({ id: 'el_2', name: 'Hidden secret', flags: { ...EMPTY_FLAGS, hidden: true } }),
    ]);
    const built = buildEgressPacket({
      graph,
      findings: [],
      plan: { paints: [], edits: [], coverage: 0, verdict: 'ok', skipped: 0 },
    });
    expect(built.packet.nodes.map((n) => n.id)).toEqual(['el_1']);
    expect(built.nodesDropped).toBe(1);
  });
});

describe('buildEgressPacket — substitution', () => {
  it('replaces the value in text with the placeholder token', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        name: 'Aadhaar',
        text: `ID ${AADHAAR} verified`,
        flags: { ...EMPTY_FLAGS, interactive: true },
      }),
    ]);
    const built = buildEgressPacket({
      graph,
      findings: [
        finding({
          id: 'f1',
          elementId: 'el_1',
          field: 'text',
          span: { start: 3, end: 15 },
          matchedText: AADHAAR,
        }),
      ],
      plan: {
        paints: [],
        edits: [
          {
            elementId: 'el_1',
            piiType: 'aadhaar',
            at: { field: 'text', span: { start: 3, end: 15 } },
            replacement: 'AADHAAR_1',
          },
        ],
        coverage: 0,
        verdict: 'ok',
        skipped: 0,
      },
    });
    expect(built.json).not.toContain(AADHAAR);
    expect(built.packet.nodes[0]?.text).toBe('ID AADHAAR_1 verified');
  });

  /**
   * A span is an offset into one specific string. Applying one measured against
   * `value` to `text` cuts the wrong characters — mangling the text while leaving the
   * secret in place — so an edit only rewrites the field it was measured against.
   */
  it('never applies a span to a field it was not measured against', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        name: 'Aadhaar',
        text: 'Some unrelated caption here',
        flags: { ...EMPTY_FLAGS, interactive: true },
      }),
    ]);
    const built = buildEgressPacket({
      graph,
      findings: [],
      plan: {
        paints: [],
        edits: [
          {
            elementId: 'el_1',
            piiType: 'aadhaar',
            // Measured against the element's `value`, which is never transmitted.
            at: { field: 'value', span: { start: 0, end: 12 } },
            replacement: 'AADHAAR_1',
          },
        ],
        coverage: 0,
        verdict: 'ok',
        skipped: 0,
      },
    });
    expect(built.packet.nodes[0]?.text).toBe('Some unrelated caption here');
  });

  /**
   * A whole-field edit comes from a structural finding — "this input declares it
   * holds a password" — where the secret is the element's value. Its accessible name
   * is the visible label, which is not sensitive and is the only thing telling the
   * model what the field is for.
   */
  it('leaves the accessible name alone for a whole-field edit', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        name: 'Password',
        tag: 'input',
        inputType: 'password',
        flags: { ...EMPTY_FLAGS, interactive: true, editable: true },
      }),
    ]);
    const built = buildEgressPacket({
      graph,
      findings: [],
      plan: {
        paints: [],
        edits: [{ elementId: 'el_1', piiType: 'password', replacement: 'PASSWORD_0' }],
        coverage: 0,
        verdict: 'ok',
        skipped: 0,
      },
    });
    expect(built.packet.nodes[0]?.name).toBe('Password');
  });

  /**
   * The catalogue is how the server satisfies the "aware of the redaction scheme"
   * requirement: it learns what the token means, never its value.
   */
  it('describes each placeholder without disclosing it', () => {
    const built = buildEgressPacket({
      graph: graphOf([
        node({ id: 'el_1', name: 'x', flags: { ...EMPTY_FLAGS, interactive: true } }),
      ]),
      findings: [
        finding({ id: 'f1', elementId: 'el_1', slot: 'primary', matchedText: AADHAAR }),
      ],
      plan: {
        paints: [],
        edits: [{ elementId: 'el_1', piiType: 'aadhaar', replacement: 'AADHAAR_PRIMARY' }],
        coverage: 0,
        verdict: 'ok',
        skipped: 0,
      },
    });
    const entry = built.packet.placeholders[0];
    expect(entry?.token).toBe('AADHAAR_PRIMARY');
    expect(entry?.piiType).toBe('aadhaar');
    expect(entry?.length).toBe(AADHAAR.length);
    expect(entry?.available).toBe(true);
  });

  /**
   * Why "fill this page" used to be impossible.
   *
   * The catalogue was built purely from the redaction plan, and the plan only has
   * entries for values a detector found on the current screen. A blank login form has
   * nothing to detect, so the model was handed an empty list and could not know the
   * vault held anything — a missing input, not a prompt weakness.
   */
  it('offers saved values even when nothing on the page matches them', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        name: 'Roll number',
        tag: 'input',
        flags: { ...EMPTY_FLAGS, interactive: true, editable: true },
      }),
    ]);
    const built = buildEgressPacket({
      graph,
      findings: [],
      plan: { paints: [], edits: [], coverage: 0, verdict: 'ok', skipped: 0 },
      vault: [{ piiType: 'roll_number', value: '21CS042', slot: 'rollnumber1' }],
    });

    const entry = built.packet.placeholders.find((p) => p.piiType === 'roll_number');
    expect(entry?.token).toBe('ROLL_NUMBER_ROLLNUMBER1');
    expect(entry?.available).toBe(true);
    expect(entry?.length).toBe(7);
    // Shape, never content.
    expect(built.json).not.toContain('21CS042');
  });

  /** A one-time code is not stored, so offering it would be a lie. */
  it('does not offer an ephemeral vault value', () => {
    const built = buildEgressPacket({
      graph: graphOf([
        node({ id: 'el_1', name: 'Code', flags: { ...EMPTY_FLAGS, interactive: true } }),
      ]),
      findings: [],
      plan: { paints: [], edits: [], coverage: 0, verdict: 'ok', skipped: 0 },
      vault: [{ piiType: 'otp', value: '483920', slot: 'otp1' }],
    });
    expect(built.packet.placeholders).toEqual([]);
  });

  /** One entry per token, whichever source it came from. */
  it('does not list a value twice when it is also on the page', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        name: 'Aadhaar',
        text: AADHAAR,
        flags: { ...EMPTY_FLAGS, interactive: true },
      }),
    ]);
    const built = buildEgressPacket({
      graph,
      findings: [
        finding({
          id: 'f1',
          elementId: 'el_1',
          field: 'text',
          span: { start: 0, end: 12 },
          slot: 'primary',
          matchedText: AADHAAR,
        }),
      ],
      plan: {
        paints: [],
        edits: [
          {
            elementId: 'el_1',
            piiType: 'aadhaar',
            at: { field: 'text', span: { start: 0, end: 12 } },
            replacement: 'AADHAAR_PRIMARY',
            matchedText: AADHAAR,
          },
        ],
        coverage: 0,
        verdict: 'ok',
        skipped: 0,
      },
      vault: [{ piiType: 'aadhaar', value: AADHAAR, slot: 'primary' }],
    });

    const tokens = built.packet.placeholders.map((p) => p.token);
    expect(tokens).toEqual(['AADHAAR_PRIMARY']);
  });

  /**
   * An OTP is never stored, so the agent cannot fill it in. Saying so up front is
   * what lets the model plan a step that asks the user instead of one that fails.
   */
  it('marks ephemeral secrets as unavailable even when a slot exists', () => {
    const built = buildEgressPacket({
      graph: graphOf([
        node({ id: 'el_1', name: 'x', flags: { ...EMPTY_FLAGS, interactive: true } }),
      ]),
      findings: [
        finding({
          id: 'f1',
          piiType: 'otp',
          elementId: 'el_1',
          slot: 'sms',
          matchedText: '483920',
        }),
      ],
      plan: {
        paints: [],
        edits: [{ elementId: 'el_1', piiType: 'otp', replacement: 'OTP_SMS' }],
        coverage: 0,
        verdict: 'ok',
        skipped: 0,
      },
    });
    expect(built.packet.placeholders[0]?.available).toBe(false);
  });

  /**
   * Without this the model sees black rectangles and cannot distinguish a
   * redaction from a dark UI element, and may conclude the page failed to load.
   */
  it('tells the model where the image was masked', () => {
    const built = buildEgressPacket({
      graph: graphOf([]),
      findings: [],
      plan: {
        paints: [
          {
            rect: { x: 10, y: 20, width: 100, height: 30 },
            mode: 'mask_solid',
            piiTypes: ['aadhaar'],
          },
        ],
        edits: [],
        coverage: 0.01,
        verdict: 'ok',
        skipped: 0,
      },
    });
    expect(built.packet.redactedRegions).toEqual([
      { rect: [10, 20, 100, 30], piiTypes: ['aadhaar'], mode: 'mask_solid' },
    ]);
  });
});

describe('buildEgressPacket — leak canary', () => {
  const vault: readonly KnownValue[] = [
    { piiType: 'aadhaar', value: AADHAAR, slot: 'primary' },
  ];

  /**
   * The case that used to kill every run.
   *
   * A plan covers the element's `text` and the same secret is also sitting in its
   * accessible `name`, which the span edit does not touch. That is not a hypothetical:
   * Google puts the signed-in account's email in an `aria-label`, so the agent aborted
   * on the second step of every task.
   *
   * It used to throw, and throwing was correct — the value really was about to be
   * transmitted. The fix is that it no longer survives: the value sweep erases every
   * known literal from every outbound string, so this now passes cleanly with the name
   * scrubbed.
   */
  it('scrubs a secret the span edits missed, instead of aborting', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        name: `Aadhaar ${AADHAAR}`,
        text: `ID ${AADHAAR}`,
        flags: { ...EMPTY_FLAGS, interactive: true },
      }),
    ]);

    const built = buildEgressPacket({
      graph,
      findings: [
        finding({
          id: 'f1',
          elementId: 'el_1',
          field: 'text',
          span: { start: 3, end: 15 },
          matchedText: AADHAAR,
        }),
      ],
      plan: {
        paints: [],
        edits: [
          {
            elementId: 'el_1',
            piiType: 'aadhaar',
            at: { field: 'text', span: { start: 3, end: 15 } },
            replacement: 'AADHAAR_1',
            matchedText: AADHAAR,
          },
        ],
        coverage: 0,
        verdict: 'ok',
        skipped: 0,
      },
      vault,
    });

    expect(built.json).not.toContain(AADHAAR);
    expect(built.packet.nodes[0]?.name).toBe('Aadhaar AADHAAR_1');
    // The precise, span-scoped substitution still wins where it applies.
    expect(built.packet.nodes[0]?.text).toBe('ID AADHAAR_1');
  });

  /**
   * The vault is swept unconditionally, whether or not any detector fired.
   *
   * This matters most on a page the detectors read badly: the user asserted these
   * values are theirs, so they are erased on the way out regardless of whether
   * anything recognised them on the way in.
   */
  it('erases a vault value no detector found', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        name: `Aadhaar ${AADHAAR}`,
        flags: { ...EMPTY_FLAGS, interactive: true },
      }),
    ]);
    const built = buildEgressPacket({
      graph,
      findings: [],
      plan: { paints: [], edits: [], coverage: 0, verdict: 'ok', skipped: 0 },
      vault,
    });
    expect(built.json).not.toContain(AADHAAR);
    expect(built.packet.nodes[0]?.name).toBe('Aadhaar AADHAAR_PRIMARY');
  });

  /**
   * Formatting is cosmetic on an identifier, and the page chooses it, not the user.
   * A scrubber replacing only the literal it was handed would leave the spaced copy on
   * the wire — which is why it shares `searchPatternFor` with the detector.
   */
  it('erases a differently formatted copy of a vault value', () => {
    const spaced = '4321 8765 2109';
    const graph = graphOf([
      node({
        id: 'el_1',
        name: `Aadhaar ${spaced}`,
        flags: { ...EMPTY_FLAGS, interactive: true },
      }),
    ]);
    const built = buildEgressPacket({
      graph,
      findings: [],
      plan: { paints: [], edits: [], coverage: 0, verdict: 'ok', skipped: 0 },
      vault,
    });
    expect(built.json).not.toContain(spaced);
    expect(built.json).not.toContain(AADHAAR);
  });

  /**
   * Values the pattern or OCR layers found that the user never entered into the
   * vault are swept too, using the placeholder the plan would have assigned.
   */
  it('erases matched text even with an empty vault', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        name: 'PAN ABCPE1234F',
        flags: { ...EMPTY_FLAGS, interactive: true },
      }),
    ]);
    const built = buildEgressPacket({
      graph,
      findings: [
        finding({ id: 'f1', piiType: 'pan', elementId: 'el_1', matchedText: 'ABCPE1234F' }),
      ],
      plan: { paints: [], edits: [], coverage: 0, verdict: 'ok', skipped: 0 },
    });
    expect(built.json).not.toContain('ABCPE1234F');
  });

  /**
   * The leak that aborted a live run with "an unchecked field of the packet".
   *
   * The placeholder token is built from the vault slot, and the slot used to be
   * slugified from the user's free-text label. Label an entry with the value itself —
   * "21CS042", a natural thing to type — and the token became
   * `REGISTRATION_NUMBER_21CS042`: the value transmitted inside the very token that
   * exists to avoid transmitting it, in a field the old locator never looked at.
   *
   * `makeSlot` no longer uses the label, but entries created before that still exist,
   * so an unsafe token is rewritten on the way out.
   */
  it('does not leak a value through the placeholder token', () => {
    const ROLL = '21CS042';
    const graph = graphOf([
      node({
        id: 'el_1',
        name: 'Registration number',
        text: `Reg ${ROLL}`,
        flags: { ...EMPTY_FLAGS, interactive: true },
      }),
    ]);

    const built = buildEgressPacket({
      graph,
      findings: [
        finding({
          id: 'f1',
          piiType: 'registration_number',
          elementId: 'el_1',
          field: 'text',
          span: { start: 4, end: 11 },
          slot: ROLL.toLowerCase(),
          matchedText: ROLL,
        }),
      ],
      plan: {
        paints: [],
        edits: [
          {
            elementId: 'el_1',
            piiType: 'registration_number',
            at: { field: 'text', span: { start: 4, end: 11 } },
            // What `placeholderFor` produces from a label-derived slot.
            replacement: `REGISTRATION_NUMBER_${ROLL}`,
            matchedText: ROLL,
          },
        ],
        coverage: 0,
        verdict: 'ok',
        skipped: 0,
      },
      vault: [{ piiType: 'registration_number', value: ROLL, slot: ROLL.toLowerCase() }],
    });

    expect(built.json).not.toContain(ROLL);
    // The catalogue and the substituted text must agree, or the model refers to a
    // token the validator cannot resolve.
    const token = built.packet.placeholders[0]?.token;
    expect(token).toBeDefined();
    expect(token).not.toContain(ROLL);
    expect(built.packet.nodes[0]?.text).toContain(token);
  });

  /**
   * A survivor is withheld, not thrown on.
   *
   * There is a residual gap by design: the sweep matches name-like values on word
   * boundaries so a stored "Ram" cannot black out "Rampur", while the check here is a
   * plain substring search. A value embedded inside a longer word therefore survives the
   * sweep and is caught at this point.
   *
   * The old response was to throw and end the task. That was the wrong trade — the
   * field can simply be emptied, nothing is transmitted either way, and the user keeps
   * their task. Losing a label costs the model some context; ending the run costs the
   * user everything they were doing.
   */
  it('withholds a survivor the sweep cannot safely replace, and continues', () => {
    const graph = graphOf([
      node({
        id: 'el_9',
        // Word-boundary matching will not touch this, because the name runs straight
        // into more word characters.
        name: 'Asha Raoxyz',
        flags: { ...EMPTY_FLAGS, interactive: true },
      }),
    ]);

    const built = buildEgressPacket({
      graph,
      findings: [
        finding({
          id: 'f1',
          piiType: 'person_name',
          elementId: 'el_1',
          matchedText: 'Asha Rao',
        }),
      ],
      plan: { paints: [], edits: [], coverage: 0, verdict: 'ok', skipped: 0 },
    });

    expect(built.json).not.toContain('Asha Rao');
    expect(built.packet.nodes[0]?.name).toBe('');
    // Names the field the survivor is actually in, not the element the finding was on.
    // Reporting the finding's element sent one bug hunt to the one place that was
    // working correctly.
    expect(built.withheld).toEqual([{ field: 'nodes[el_9].name', piiType: 'person_name' }]);
    // The node itself survives, so the model can still act on it.
    expect(built.packet.nodes[0]?.id).toBe('el_9');
  });

  /**
   * The bug that ended a live run: `placeholders[9].piiType` is the literal string
   * "registration_number", written by our own code. The canary used to serialize the
   * whole packet and substring-search the blob, so it could not tell page content from
   * our own vocabulary and fired on a stored value that merely resembled a type name.
   */
  it('does not treat its own vocabulary as a leak', () => {
    const graph = graphOf([
      node({ id: 'el_1', name: 'Roll number', flags: { ...EMPTY_FLAGS, interactive: true } }),
    ]);

    const built = buildEgressPacket({
      graph,
      findings: [],
      plan: { paints: [], edits: [], coverage: 0, verdict: 'ok', skipped: 0 },
      // A value that is literally one of our type names. Nonsense as data, but easy to
      // enter while testing, and it used to make every task abort.
      vault: [{ piiType: 'registration_number', value: 'registration_number', slot: 'r1' }],
    });

    expect(built.withheld).toEqual([]);
    expect(built.packet.placeholders.some((p) => p.piiType === 'registration_number')).toBe(
      true,
    );
  });

  /** Content is checked; the title is content. */
  it('withholds the title when a value survives in it', () => {
    const built = buildEgressPacket({
      graph: { ...graphOf([]), title: 'Marks for Asha Raoxyz' },
      findings: [
        finding({
          id: 'f1',
          piiType: 'person_name',
          elementId: 'el_1',
          matchedText: 'Asha Rao',
        }),
      ],
      plan: { paints: [], edits: [], coverage: 0, verdict: 'ok', skipped: 0 },
    });

    expect(built.packet.title).toBe('');
    expect(built.withheld.map((w) => w.field)).toEqual(['packet.title']);
  });

  it('passes cleanly when redaction actually worked', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        name: 'Aadhaar Number',
        text: `ID ${AADHAAR}`,
        flags: { ...EMPTY_FLAGS, interactive: true },
      }),
    ]);
    const built = buildEgressPacket({
      graph,
      findings: [
        finding({
          id: 'f1',
          elementId: 'el_1',
          span: { start: 3, end: 15 },
          matchedText: AADHAAR,
        }),
      ],
      plan: {
        paints: [],
        edits: [
          {
            elementId: 'el_1',
            piiType: 'aadhaar',
            span: { start: 3, end: 15 },
            replacement: 'AADHAAR_1',
          },
        ],
        coverage: 0,
        verdict: 'ok',
        skipped: 0,
      },
      vault,
    });
    expect(built.json).not.toContain(AADHAAR);
    expect(built.canaryChecks).toBeGreaterThan(0);
  });

  /**
   * The screenshot is base64 image data, so a substring match there is meaningless.
   * Its safety comes from pixel masking, not string comparison — but the text must
   * still be swept, and attaching an image must not cause that to be skipped.
   */
  it('still sweeps the text when a screenshot is attached', () => {
    const graph = graphOf([
      node({
        id: 'el_1',
        name: `Aadhaar ${AADHAAR}`,
        flags: { ...EMPTY_FLAGS, interactive: true },
      }),
    ]);
    const built = buildEgressPacket({
      graph,
      findings: [],
      plan: { paints: [], edits: [], coverage: 0, verdict: 'ok', skipped: 0 },
      redactedScreenshot: 'data:image/jpeg;base64,AAAA',
      vault,
    });
    expect(built.packet.screenshot).toBe('data:image/jpeg;base64,AAAA');
    expect(built.packet.nodes[0]?.name).not.toContain(AADHAAR);
  });

  /**
   * Nothing reads the page title, so it used to go out exactly as the site wrote it.
   * A portal titled "Marks — Asha Rao (21CS042)" handed over a name and a roll number
   * with nothing applied to them at all.
   */
  it('scrubs the page title', () => {
    const built = buildEgressPacket({
      graph: {
        ...graphOf([]),
        title: `Marks for ${AADHAAR}`,
      },
      findings: [],
      plan: { paints: [], edits: [], coverage: 0, verdict: 'ok', skipped: 0 },
      vault,
    });
    expect(built.packet.title).toBe('Marks for AADHAAR_PRIMARY');
    expect(built.json).not.toContain(AADHAAR);
  });

  it('omits the screenshot when the budget refused it', () => {
    const built = buildEgressPacket({
      graph: graphOf([]),
      findings: [],
      plan: { paints: [], edits: [], coverage: 0.7, verdict: 'refuse', skipped: 0 },
      redactedScreenshot: 'data:image/jpeg;base64,AAAA',
      includeScreenshot: false,
    });
    expect(built.packet.screenshot).toBeUndefined();
  });
});
