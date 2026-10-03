/**
 * Viewport geometry helpers.
 *
 * Used in two load-bearing places:
 *  - fusing the structure channel with the pixel channel by spatial overlap
 *  - the pre-execution overlay check that defends against clickjacking
 *
 * All rects are CSS pixels in viewport coordinates unless stated otherwise.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

export function right(r: Rect): number {
  return r.x + r.width;
}

export function bottom(r: Rect): number {
  return r.y + r.height;
}

export function area(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

export function isEmpty(r: Rect): boolean {
  return r.width <= 0 || r.height <= 0;
}

export function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Overlapping region of two rects, or null when they do not overlap. */
export function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(right(a), right(b)) - x;
  const h = Math.min(bottom(a), bottom(b)) - y;
  if (w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h };
}

export function intersectionArea(a: Rect, b: Rect): number {
  const i = intersection(a, b);
  return i === null ? 0 : area(i);
}

export function unionArea(a: Rect, b: Rect): number {
  return area(a) + area(b) - intersectionArea(a, b);
}

/**
 * Intersection over union. 0 means disjoint, 1 means identical.
 * This is the primary similarity score for channel fusion.
 */
export function iou(a: Rect, b: Rect): number {
  const u = unionArea(a, b);
  if (u <= 0) return 0;
  return intersectionArea(a, b) / u;
}

/**
 * Fraction of `inner` that falls inside `outer`.
 *
 * Distinct from IoU on purpose: a small OCR word box sitting inside a large
 * button has a poor IoU but a containment of 1. Fusion needs both signals.
 */
export function containment(inner: Rect, outer: Rect): number {
  const a = area(inner);
  if (a <= 0) return 0;
  return intersectionArea(inner, outer) / a;
}

export function containsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x < right(r) && p.y >= r.y && p.y < bottom(r);
}

/** Smallest rect enclosing all inputs. Returns null for an empty list. */
export function boundingBox(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (right(r) > maxX) maxX = right(r);
    if (bottom(r) > maxY) maxY = bottom(r);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Clip a rect to a viewport box, or null if fully outside. */
export function clipTo(r: Rect, viewport: Rect): Rect | null {
  return intersection(r, viewport);
}

/** Grow (or shrink, with a negative value) a rect on every side. */
export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + by * 2, height: r.height + by * 2 };
}

/** Convert CSS pixels to device pixels, for painting redactions onto a screenshot. */
export function scale(r: Rect, factor: number): Rect {
  return {
    x: r.x * factor,
    y: r.y * factor,
    width: r.width * factor,
    height: r.height * factor,
  };
}

/** Snap to whole pixels, expanding outward so a redaction never leaves a sliver. */
export function roundOut(r: Rect): Rect {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, width: Math.ceil(right(r)) - x, height: Math.ceil(bottom(r)) - y };
}

/**
 * Total area covered by a set of possibly-overlapping rects, without
 * double-counting overlaps.
 *
 * This is how the redaction budget guard measures how much of the screen it
 * has blacked out. Implemented as a sweep over unique x boundaries.
 */
export function coveredArea(rects: readonly Rect[]): number {
  const boxes = rects.filter((r) => !isEmpty(r));
  if (boxes.length === 0) return 0;

  const xs = new Set<number>();
  for (const r of boxes) {
    xs.add(r.x);
    xs.add(right(r));
  }
  const bounds = [...xs].sort((a, b) => a - b);

  let total = 0;
  for (let i = 0; i < bounds.length - 1; i++) {
    const x0 = bounds[i] as number;
    const x1 = bounds[i + 1] as number;
    const stripWidth = x1 - x0;
    if (stripWidth <= 0) continue;

    // Collect y-spans of every box crossing this vertical strip, then merge.
    const spans: Array<[number, number]> = [];
    for (const r of boxes) {
      if (r.x <= x0 && right(r) >= x1) spans.push([r.y, bottom(r)]);
    }
    if (spans.length === 0) continue;
    spans.sort((a, b) => a[0] - b[0]);

    let mergedHeight = 0;
    let curStart = spans[0]?.[0] as number;
    let curEnd = spans[0]?.[1] as number;
    for (let j = 1; j < spans.length; j++) {
      const span = spans[j] as [number, number];
      if (span[0] > curEnd) {
        mergedHeight += curEnd - curStart;
        curStart = span[0];
        curEnd = span[1];
      } else if (span[1] > curEnd) {
        curEnd = span[1];
      }
    }
    mergedHeight += curEnd - curStart;
    total += stripWidth * mergedHeight;
  }
  return total;
}
