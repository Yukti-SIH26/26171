/**
 * Redaction planning.
 *
 * Turns findings into a concrete list of paint operations and text substitutions,
 * and decides what to do when there are too many of them.
 *
 * The interesting problem here is the budget. Redaction and usefulness pull in
 * opposite directions: the safest screenshot is entirely black, and it is also
 * worthless to the model that has to read it. So the plan tracks how much of the
 * viewport it is about to cover and escalates when that fraction gets high —
 * because a page that needs 40% of its pixels hidden is a page we should think
 * twice about sending at all, rather than one we should send with 40% hidden.
 *
 * Overlapping regions are merged before painting. Not for looks: overlapping
 * translucent or blurred draws compound, and more importantly the covered-area
 * measurement would double-count and make the budget check wrong in the unsafe
 * direction.
 */

import {
  boundingBox,
  coveredArea,
  inflate,
  intersection,
  isEmpty,
  roundOut,
  type Rect,
  type RedactionMode,
  type ViewportInfo,
} from '@sih/core';
import type { PiiFinding, TextField } from '../pii/detect.ts';

export interface PaintOp {
  readonly rect: Rect;
  readonly mode: RedactionMode;
  /** Types covered by this rectangle, after merging. For the audit trail. */
  readonly piiTypes: readonly string[];
}

/**
 * Exactly where inside an element a value sits.
 *
 * Field and span travel together deliberately, as one object rather than two
 * optional siblings. A span is an offset into one specific string, and an element has
 * several — `text`, `name`, `value`. Applying a span measured against `value` to
 * `text` cuts at the wrong offsets, which mangles the text *and* leaves the secret in
 * place. Pairing them makes a span without its field unrepresentable, so that mistake
 * cannot be made again.
 */
export interface TextLocation {
  readonly field: TextField;
  readonly span: { readonly start: number; readonly end: number };
}

export interface TextEdit {
  readonly elementId: string;
  readonly piiType: string;
  /** Where to substitute. Absent means the whole field is replaced or dropped. */
  readonly at?: TextLocation;
  /** What the server will see instead of the real value. */
  readonly replacement: string;
  /** Present only for `drop`, where the field is removed entirely. */
  readonly drop?: boolean;
  /**
   * The literal this edit replaces, when known.
   *
   * Feeds the outbound value sweep, which is what catches copies of the same value
   * in places no finding pointed at.
   */
  readonly matchedText?: string;
}

export type BudgetVerdict =
  /** Normal case: redact and send. */
  | 'ok'
  /** A lot is hidden. Send, but the UI says so and the audit log records it. */
  | 'heavy'
  /** So much is hidden that sending is worse than not sending. */
  | 'refuse';

export interface RedactionPlan {
  readonly paints: readonly PaintOp[];
  readonly edits: readonly TextEdit[];
  /** Fraction of the viewport that will be covered, 0..1. */
  readonly coverage: number;
  readonly verdict: BudgetVerdict;
  readonly reason?: string;
  /** Findings that produced no paint op because they had no usable geometry. */
  readonly skipped: number;
}

/**
 * Coverage above which the screenshot is flagged as heavily redacted.
 *
 * Not a failure — some pages genuinely are mostly sensitive data, and a marksheet
 * is the obvious example. But the user should be told, and the number should be in
 * the audit record.
 */
const HEAVY_COVERAGE = 0.25;

/**
 * Coverage above which we refuse to send the screenshot at all.
 *
 * At this point the image carries so little signal that the remote model would be
 * guessing, and guessing is worse than the agent admitting it cannot see. Refusing
 * is the honest failure mode.
 */
const REFUSE_COVERAGE = 0.6;

/**
 * Pad every redaction outwards before painting.
 *
 * Text metrics are estimated, antialiasing bleeds, and a box that is one pixel too
 * small leaves a legible sliver of a digit. Padding outwards is cheap; padding
 * inwards is a leak.
 */
const SAFETY_PAD = 3;

/** Regions closer than this get merged into one rectangle. */
const MERGE_GAP = 6;

/**
 * Merge overlapping and near-touching rectangles that share a redaction mode.
 *
 * Modes are kept separate because they are not interchangeable: merging a blur
 * region into a solid mask region would be safe but would needlessly black out a
 * face, and merging the other way would be a genuine downgrade.
 */
function mergeByMode(ops: readonly PaintOp[]): PaintOp[] {
  const byMode = new Map<RedactionMode, PaintOp[]>();
  for (const op of ops) {
    const list = byMode.get(op.mode) ?? [];
    list.push(op);
    byMode.set(op.mode, list);
  }

  const merged: PaintOp[] = [];

  for (const [mode, list] of byMode) {
    const pending = [...list];
    const done: PaintOp[] = [];

    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;

      let rect = current.rect;
      const types = new Set(current.piiTypes);
      let absorbedSomething = true;

      // Repeat until nothing more merges: absorbing one rectangle can grow the
      // region enough to reach a third that was previously too far away.
      while (absorbedSomething) {
        absorbedSomething = false;
        for (let i = pending.length - 1; i >= 0; i--) {
          const other = pending[i];
          if (other === undefined) continue;

          // `intersection` returns null for disjoint rectangles, which is the
          // common case here — most redactions are nowhere near each other.
          const touching = intersection(inflate(rect, MERGE_GAP), other.rect);
          if (touching === null || isEmpty(touching)) continue;

          const union = boundingBox([rect, other.rect]);
          if (union === null) continue;

          rect = union;
          for (const t of other.piiTypes) types.add(t);
          pending.splice(i, 1);
          absorbedSomething = true;
        }
      }

      done.push({ rect, mode, piiTypes: [...types].sort() });
    }

    merged.push(...done);
  }

  return merged;
}

/**
 * Build the placeholder token the remote model will see.
 *
 * Stable and type-revealing on purpose. The model needs to know that *an Aadhaar
 * number* belongs in this field to reason about the form, and it needs the same
 * token to refer to the same value across turns so it can say "type AADHAAR_1
 * here". What it must never see is the digits.
 */
export function placeholderFor(
  piiType: string,
  slot: string | undefined,
  index: number,
): string {
  const base = piiType.toUpperCase();
  return slot === undefined ? `${base}_${String(index)}` : `${base}_${slot.toUpperCase()}`;
}

/**
 * Shape-preserving stand-in for a value.
 *
 * Used where the model needs to see a plausible value rather than a token —
 * layout and validation logic can behave differently for `SYNTHETIC` versus
 * something that looks like a real name. Digits become digits and letters become
 * letters, so length and character class survive while the content does not.
 */
export function syntheticFor(piiType: string, original: string | undefined): string {
  if (original === undefined || original === '') return placeholderFor(piiType, undefined, 0);

  let out = '';
  for (const char of original) {
    if (/\d/.test(char)) out += '9';
    else if (/[a-z]/.test(char)) out += 'x';
    else if (/[A-Z]/.test(char)) out += 'X';
    else out += char;
  }
  return out;
}

export interface PlanOptions {
  readonly findings: readonly PiiFinding[];
  readonly viewport: ViewportInfo;
  /** Clip every region to this box. Usually the captured frame in CSS pixels. */
  readonly bounds: Rect;
}

export function planRedaction(options: PlanOptions): RedactionPlan {
  const { findings, viewport, bounds } = options;

  const rawPaints: PaintOp[] = [];
  const edits: TextEdit[] = [];
  let skipped = 0;
  let placeholderIndex = 0;

  for (const finding of findings) {
    // `none` means policy decided this type is not worth hiding. Nothing to do,
    // and it is not a skip — it is a deliberate decision.
    if (finding.redaction === 'none') continue;

    const clipped = intersection(roundOut(inflate(finding.rect, SAFETY_PAD)), bounds);
    if (clipped === null || isEmpty(clipped)) {
      // Off-screen or degenerate geometry. It still needs a text edit if it has an
      // element, because the *text* copy of the page is sent alongside the image
      // and a value hidden in the picture but present in the text is not hidden.
      skipped++;
    } else {
      rawPaints.push({
        rect: clipped,
        mode: finding.redaction,
        piiTypes: [finding.piiType],
      });
    }

    if (finding.elementId === undefined) continue;

    // Common to every mode: which element and what the value literally said.
    // `matchedText` feeds the outbound value sweep, which is what catches copies of
    // the same value in places no finding pointed at.
    const where = {
      elementId: finding.elementId,
      piiType: finding.piiType,
      ...(finding.matchedText === undefined ? {} : { matchedText: finding.matchedText }),
    };

    // Where in the element, for the modes that rewrite in place rather than
    // wholesale. `drop` deliberately carries none of it: it removes the whole field.
    //
    // Both parts or neither. A span whose field is unknown cannot be applied safely,
    // so it is discarded here and the value sweep at the end catches the literal
    // instead.
    const at =
      finding.field === undefined || finding.span === undefined
        ? {}
        : { at: { field: finding.field, span: finding.span } };

    switch (finding.redaction) {
      case 'drop':
        edits.push({ ...where, drop: true, replacement: '' });
        break;
      case 'synthetic':
        edits.push({
          ...where,
          ...at,
          replacement: syntheticFor(finding.piiType, finding.matchedText),
        });
        break;
      default:
        // Solid mask and blur both hide pixels, but the text copy still contains
        // the value, so it is replaced with a token regardless of paint mode.
        edits.push({
          ...where,
          ...at,
          replacement: placeholderFor(finding.piiType, finding.slot, placeholderIndex++),
        });
        break;
    }
  }

  const paints = mergeByMode(rawPaints);

  // `coveredArea` unions the rectangles rather than summing them, so overlapping
  // regions are not counted twice. Summing would overstate coverage and could
  // trip the refusal threshold on a page that is actually fine.
  const viewportArea = Math.max(1, viewport.width * viewport.height);
  const coverage = Math.min(1, coveredArea(paints.map((p) => p.rect)) / viewportArea);

  let verdict: BudgetVerdict = 'ok';
  let reason: string | undefined;

  if (coverage >= REFUSE_COVERAGE) {
    verdict = 'refuse';
    reason =
      `${(coverage * 100).toFixed(0)}% of the viewport is sensitive. Sending a screenshot ` +
      `this heavily masked would leave the remote model guessing, which is worse than ` +
      `telling you it cannot see. Narrow the task or work from the page structure alone.`;
  } else if (coverage >= HEAVY_COVERAGE) {
    verdict = 'heavy';
    reason =
      `${(coverage * 100).toFixed(0)}% of the viewport is masked. The model will see the ` +
      `layout but little of the content.`;
  }

  return {
    paints,
    edits,
    coverage,
    verdict,
    ...(reason === undefined ? {} : { reason }),
    skipped,
  };
}

export { HEAVY_COVERAGE, REFUSE_COVERAGE, SAFETY_PAD };
