import { describe, expect, it } from 'vitest';
import {
  area,
  boundingBox,
  center,
  clipTo,
  containment,
  containsPoint,
  coveredArea,
  inflate,
  intersection,
  iou,
  isEmpty,
  rect,
  roundOut,
  scale,
} from '../src/geometry.ts';

describe('basic measures', () => {
  it('computes area and emptiness', () => {
    expect(area(rect(0, 0, 10, 5))).toBe(50);
    expect(area(rect(0, 0, 0, 5))).toBe(0);
    expect(isEmpty(rect(0, 0, 0, 5))).toBe(true);
    expect(isEmpty(rect(0, 0, 1, 1))).toBe(false);
  });

  it('never reports negative area', () => {
    expect(area(rect(0, 0, -10, -10))).toBe(0);
  });

  it('computes centre', () => {
    expect(center(rect(10, 20, 30, 40))).toEqual({ x: 25, y: 40 });
  });
});

describe('intersection', () => {
  it('returns the overlapping region', () => {
    expect(intersection(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toEqual(rect(5, 5, 5, 5));
  });

  it('returns null for disjoint rects', () => {
    expect(intersection(rect(0, 0, 10, 10), rect(20, 20, 5, 5))).toBeNull();
  });

  it('treats edge-touching rects as disjoint', () => {
    // Shared border is zero-area, which must not count as overlap or every
    // adjacent element would appear fused.
    expect(intersection(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBeNull();
  });
});

describe('iou', () => {
  it('is 1 for identical rects', () => {
    expect(iou(rect(3, 4, 10, 10), rect(3, 4, 10, 10))).toBe(1);
  });

  it('is 0 for disjoint rects', () => {
    expect(iou(rect(0, 0, 5, 5), rect(100, 100, 5, 5))).toBe(0);
  });

  it('computes partial overlap', () => {
    // 25 shared / 175 union
    expect(iou(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toBeCloseTo(25 / 175, 10);
  });

  it('is 0 when either rect is degenerate', () => {
    expect(iou(rect(0, 0, 0, 0), rect(0, 0, 0, 0))).toBe(0);
  });
});

describe('containment', () => {
  it('is 1 when inner sits fully inside outer', () => {
    // The fusion case that IoU handles badly: a small OCR word box inside a
    // large button. IoU is low, containment is 1.
    const word = rect(12, 14, 20, 8);
    const button = rect(10, 10, 100, 40);
    expect(containment(word, button)).toBe(1);
    expect(iou(word, button)).toBeLessThan(0.1);
  });

  it('is fractional for partial overlap', () => {
    expect(containment(rect(0, 0, 10, 10), rect(5, 0, 10, 10))).toBeCloseTo(0.5, 10);
  });

  it('is 0 for a degenerate inner rect', () => {
    expect(containment(rect(0, 0, 0, 0), rect(0, 0, 10, 10))).toBe(0);
  });
});

describe('point hit testing', () => {
  it('includes the top-left edge and excludes the bottom-right', () => {
    const r = rect(0, 0, 10, 10);
    expect(containsPoint(r, { x: 0, y: 0 })).toBe(true);
    expect(containsPoint(r, { x: 9.99, y: 9.99 })).toBe(true);
    expect(containsPoint(r, { x: 10, y: 5 })).toBe(false);
    expect(containsPoint(r, { x: 5, y: 10 })).toBe(false);
  });
});

describe('boundingBox', () => {
  it('returns null for an empty list', () => {
    expect(boundingBox([])).toBeNull();
  });

  it('encloses every input', () => {
    expect(boundingBox([rect(10, 10, 5, 5), rect(0, 30, 5, 5)])).toEqual(rect(0, 10, 15, 25));
  });
});

describe('transforms', () => {
  it('clips to a viewport', () => {
    expect(clipTo(rect(-10, -10, 30, 30), rect(0, 0, 100, 100))).toEqual(rect(0, 0, 20, 20));
    expect(clipTo(rect(200, 200, 10, 10), rect(0, 0, 100, 100))).toBeNull();
  });

  it('inflates on every side', () => {
    expect(inflate(rect(10, 10, 10, 10), 5)).toEqual(rect(5, 5, 20, 20));
  });

  it('scales CSS pixels to device pixels', () => {
    expect(scale(rect(10, 20, 30, 40), 2)).toEqual(rect(20, 40, 60, 80));
  });

  it('rounds outward so a redaction never leaves an uncovered sliver', () => {
    // 10.4..15.7 -> 10..16, 20.6..25.7 -> 20..26
    expect(roundOut(rect(10.4, 20.6, 5.3, 5.1))).toEqual(rect(10, 20, 6, 6));
  });

  it('always fully encloses the original rect', () => {
    // The invariant that matters: a rounded redaction box must never expose a
    // subpixel strip of the thing it is covering.
    const samples = [
      rect(10.4, 20.6, 5.3, 5.1),
      rect(0.1, 0.9, 0.2, 0.2),
      rect(-3.7, 12.25, 8.8, 4.4),
      rect(100, 200, 50, 25),
    ];
    for (const r of samples) {
      const out = roundOut(r);
      expect(out.x).toBeLessThanOrEqual(r.x);
      expect(out.y).toBeLessThanOrEqual(r.y);
      expect(out.x + out.width).toBeGreaterThanOrEqual(r.x + r.width);
      expect(out.y + out.height).toBeGreaterThanOrEqual(r.y + r.height);
      expect(Number.isInteger(out.x)).toBe(true);
      expect(Number.isInteger(out.y)).toBe(true);
      expect(Number.isInteger(out.width)).toBe(true);
      expect(Number.isInteger(out.height)).toBe(true);
    }
  });
});

describe('coveredArea', () => {
  it('is 0 for no rects', () => {
    expect(coveredArea([])).toBe(0);
  });

  it('ignores degenerate rects', () => {
    expect(coveredArea([rect(0, 0, 0, 10), rect(5, 5, 10, 0)])).toBe(0);
  });

  it('sums disjoint rects', () => {
    expect(coveredArea([rect(0, 0, 10, 10), rect(50, 50, 10, 10)])).toBe(200);
  });

  it('does not double count identical rects', () => {
    expect(coveredArea([rect(0, 0, 10, 10), rect(0, 0, 10, 10)])).toBe(100);
  });

  it('computes the union of overlapping rects', () => {
    expect(coveredArea([rect(0, 0, 10, 10), rect(5, 5, 10, 10)])).toBe(175);
  });

  it('merges vertically disjoint spans in the same column', () => {
    expect(coveredArea([rect(0, 0, 10, 10), rect(0, 20, 10, 10)])).toBe(200);
  });

  it('handles a chain of partial overlaps', () => {
    const covered = coveredArea([rect(0, 0, 10, 10), rect(5, 0, 10, 10), rect(10, 0, 10, 10)]);
    // Continuous band from x=0 to x=20, height 10.
    expect(covered).toBe(200);
  });

  it('handles a rect fully inside another', () => {
    expect(coveredArea([rect(0, 0, 100, 100), rect(10, 10, 10, 10)])).toBe(10000);
  });

  // This is the number the redaction budget guard thresholds on, so an
  // over-count here would make the guard refuse valid payloads.
  it('gives a redacted fraction below 1 for a realistic redaction set', () => {
    const viewport = rect(0, 0, 1280, 720);
    const redactions = [
      rect(100, 100, 200, 24),
      rect(100, 140, 200, 24),
      rect(100, 180, 320, 24),
      rect(900, 80, 120, 120),
    ];
    const fraction = coveredArea(redactions) / area(viewport);
    expect(fraction).toBeGreaterThan(0);
    expect(fraction).toBeLessThan(0.1);
  });
});
