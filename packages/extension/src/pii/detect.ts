/**
 * PII detection orchestrator.
 *
 * Runs every detector over the fused element graph and the OCR word list, then
 * merges their findings into one set of regions with a confidence each.
 *
 * Three properties this has to get right:
 *
 *  1. **Every detector always runs.** They fail in different ways — patterns miss
 *     unusual formats, structure misses values in plain text, the vault misses
 *     anything the user never entered — and the union is much stronger than any
 *     one of them. There is no "primary" detector.
 *
 *  2. **Fusion is by maximum, not average.** Averaging would let two weak
 *     detectors dilute one strong one. If the vault says with certainty that this
 *     string is the user's Aadhaar number, a weak pattern disagreeing must not
 *     drag the score below the redaction threshold.
 *
 *  3. **Every finding carries a rectangle.** A finding without pixel geometry
 *     cannot be redacted from a screenshot, which is the whole point. Findings in
 *     element text get the element's box; findings in OCR text get the word's box.
 *     Text-level findings additionally carry a character span so the *text* copy
 *     can be substituted precisely rather than wholesale.
 */

import {
  fuseConfidence,
  policyFor,
  resolveRedactionMode,
  shouldRedact,
  type ElementGraph,
  type ElementNode,
  type PiiDetection,
  type PiiType,
  type Rect,
  type RedactionMode,
} from '@sih/core';
import { visualPiiType } from '../models/catalogue.ts';
import type { OcrWord } from '../models/ocr.ts';
import { findPatterns } from './patterns.ts';
import { classifyElement, hasConflictingSignals } from './structural.ts';
import {
  MIN_SEARCHABLE_LENGTH,
  findKnownValues,
  searchPatternFor,
  type KnownValue,
} from './known-values.ts';

/**
 * A detection promoted to a decision.
 *
 * `PiiDetection` is one detector's opinion. A `PiiFinding` is the fused verdict
 * for one piece of sensitive data, with the redaction mode already resolved
 * against policy — including the blur downgrade for high-value types.
 */
export interface PiiFinding {
  readonly id: string;
  readonly piiType: PiiType;
  readonly confidence: number;
  readonly redaction: RedactionMode;
  /** Pixel region to paint over. Always present. */
  readonly rect: Rect;
  readonly elementId?: string;
  /**
   * Which of the element's strings the match was found in.
   *
   * `span` is an offset into *this* field and nothing else. The egress builder
   * rewrites several strings per element, and applying a span from one to another
   * cuts the wrong characters — corrupting the text while leaving the secret intact.
   */
  readonly field?: TextField;
  /** Character span inside the field named above, when known. */
  readonly span?: { readonly start: number; readonly end: number };
  /** Which detectors contributed, for the audit trail and the metrics harness. */
  readonly detectors: readonly string[];
  /** Vault slot, when the value came from the vault. Drives the placeholder. */
  readonly slot?: string;
  /**
   * The literal text found. Never leaves the device — the egress builder strips
   * this field, and the leak canary uses it to assert the strip worked.
   */
  readonly matchedText?: string;
  /** Attribute and label signals disagreed. Possible bait field. */
  readonly conflicting?: boolean;
}

export interface DetectInput {
  readonly graph: ElementGraph;
  readonly words?: readonly OcrWord[];
  readonly vault?: readonly KnownValue[];
}

export interface DetectStats {
  readonly elementsScanned: number;
  readonly wordsScanned: number;
  readonly byDetector: Readonly<Record<string, number>>;
  readonly byType: Readonly<Record<string, number>>;
  /** Found, but below the policy threshold, so not redacted. */
  readonly belowThreshold: number;
  readonly conflicts: number;
  readonly durationMs: number;
}

export interface DetectResult {
  readonly findings: readonly PiiFinding[];
  readonly stats: DetectStats;
}

/**
 * Estimate the pixel box of a character span inside an element.
 *
 * A rough single-line interpolation across the element's width. It is imprecise
 * by design: erring wide is safe (a slightly larger black box), erring narrow
 * would leave part of a secret visible. So the box is padded and clamped to the
 * element rather than fitted tightly.
 *
 * Exact glyph geometry would need `Range.getClientRects()` in the page context.
 * That is a worthwhile upgrade, but it is not available here in the side panel,
 * and a conservative over-estimate is the right failure mode meanwhile.
 */
function spanRect(node: ElementNode, textLength: number, start: number, end: number): Rect {
  const { rect } = node;
  if (textLength <= 0 || rect.width <= 0) return rect;

  // Multi-line text cannot be interpolated horizontally with any confidence, so
  // cover the whole element instead of guessing at a line box.
  const approxCharWidth = rect.width / textLength;
  const looksMultiline = rect.height > 32 && textLength * 6 > rect.width * 1.5;
  if (looksMultiline) return rect;

  const x = rect.x + approxCharWidth * start;
  const width = approxCharWidth * (end - start);

  // Pad by roughly one character on each side, then clamp back inside the
  // element. Antialiasing and kerning both push glyphs slightly outside a naive
  // linear estimate.
  const pad = Math.max(2, approxCharWidth);
  const left = Math.max(rect.x, x - pad);
  const right = Math.min(rect.x + rect.width, x + width + pad);

  return { x: left, y: rect.y, width: Math.max(1, right - left), height: rect.height };
}

/**
 * Text on an element that could contain a secret, with where it came from.
 *
 * `name` and `placeholder` are here because the egress packet transmits the
 * accessible name. Leaving them out was a real leak rather than an oversight in
 * coverage: a page can put a value in an `aria-label`, an `alt`, or a button's label
 * — Google puts the signed-in account's email in exactly that place — and nothing
 * ever looked at it, so it went out verbatim while the copy in `text` was masked.
 *
 * The `field` tag is load-bearing, not diagnostic. Spans are offsets into one
 * specific string, and the packet rewrites several. Applying a span computed against
 * `value` to `text` slices the wrong characters: it corrupts the text *and* leaves
 * the secret in place. So every match carries the field it was found in, and the
 * rewriter only applies a span to the string it was measured against.
 */
export type TextField = 'value' | 'text' | 'ocr' | 'name' | 'placeholder';

function scannableText(node: ElementNode): { field: TextField; text: string }[] {
  const out: { field: TextField; text: string }[] = [];
  if (node.value !== undefined && node.value !== '')
    out.push({ field: 'value', text: node.value });
  if (node.text !== undefined && node.text !== '') out.push({ field: 'text', text: node.text });

  // Transmitted by the packet, so it must be scanned.
  if (node.name !== '') out.push({ field: 'name', text: node.name });

  // Not transmitted today, but a placeholder routinely shows a real example value
  // ("e.g. 4321 8765 2109") and it is rendered on screen, so it needs a rect.
  if (node.placeholder !== undefined && node.placeholder !== '') {
    out.push({ field: 'placeholder', text: node.placeholder });
  }

  // OCR text attached during channel fusion. This is the only text available for
  // an element whose content is pure pixels, which is exactly the case the DOM
  // walk is blind to.
  const ocrText = (node.detectorMeta as { ocrText?: unknown } | undefined)?.ocrText;
  if (typeof ocrText === 'string' && ocrText !== '') out.push({ field: 'ocr', text: ocrText });

  return out;
}

/**
 * Where to paint for a match in a given field.
 *
 * Interpolating a character span across the element's width only means anything when
 * the string is the element's rendered content. An `aria-label` frequently differs
 * from what is drawn, and a `placeholder` is drawn only while the field is empty, so
 * for those the whole element box is used. Over-covering one element is a cosmetic
 * cost; under-covering it is a leak.
 */
function rectForMatch(
  node: ElementNode,
  field: TextField,
  textLength: number,
  start: number,
  end: number,
): Rect {
  if (field === 'name' || field === 'placeholder') return node.rect;
  return spanRect(node, textLength, start, end);
}

/**
 * Context for classifying a value.
 *
 * Built from everything *around* the value rather than the value itself, which is
 * what lets a bare 6-digit number be recognised as an OTP because the label next
 * to it says so.
 */
function contextFor(node: ElementNode): string {
  return [node.name, node.placeholder, node.fieldName, node.role, node.text]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .join(' ');
}

interface Bucket {
  readonly piiType: PiiType;
  readonly rect: Rect;
  readonly detections: PiiDetection[];
  readonly detectors: Set<string>;
  elementId?: string;
  field?: TextField;
  span?: { start: number; end: number };
  slot?: string;
  matchedText?: string;
  conflicting?: boolean;
}

/**
 * Key that decides whether two detections describe the same secret.
 *
 * Keyed on element, type, field, and span so that two detectors finding the same
 * value merge into one finding with the higher confidence, while two *different*
 * secrets of the same type in one element stay separate.
 *
 * `field` is part of the key because the same offsets in `name` and in `text` are
 * different places. Without it, a match at 0..14 in an aria-label would merge with
 * one at 0..14 in the visible text and only one of the two would ever be rewritten.
 */
function bucketKey(
  piiType: PiiType,
  elementId: string | undefined,
  field: TextField | undefined,
  span: { start: number; end: number } | undefined,
  rect?: Rect,
): string {
  // OCR-only findings have no element id. Include their geometry so two secrets of
  // the same type in different parts of a screenshot do not collapse into one mask.
  const location =
    elementId ??
    (rect === undefined
      ? '-'
      : `ocr:${String(Math.round(rect.x))}:${String(Math.round(rect.y))}:${String(Math.round(rect.width))}:${String(Math.round(rect.height))}`);
  return [
    piiType,
    location,
    field ?? '-',
    span === undefined ? '-' : `${String(span.start)}:${String(span.end)}`,
  ].join('|');
}

/** One confirmed literal and what it was recognised as. */
interface ConfirmedValue {
  readonly piiType: PiiType;
  readonly text: string;
  readonly confidence: number;
  readonly slot?: string;
}

/**
 * Find every other place a confirmed value appears, and record it.
 *
 * Confidence is carried over from the original detection rather than reset: the
 * evidence is that this exact literal is a phone number, and that evidence does not
 * weaken because the same literal turned up in a second element. Resetting it to a
 * guess would push the copies below their policy threshold and leave them visible,
 * which is the whole problem this solves.
 *
 * `existing` short-circuits a location that already has a bucket for this type, so a
 * value never counts itself.
 */
function propagateConfirmedValues(
  buckets: Map<string, Bucket>,
  graph: ElementGraph,
  words: readonly OcrWord[],
  record: (
    detection: PiiDetection,
    rect: Rect,
    extra: {
      elementId?: string;
      field?: TextField;
      span?: { start: number; end: number };
      slot?: string;
      matchedText?: string;
    },
  ) => void,
  nextId: () => string,
): void {
  // Deduplicate by literal, keeping the strongest evidence and any vault slot.
  const confirmed = new Map<string, ConfirmedValue>();
  for (const bucket of buckets.values()) {
    const text = bucket.matchedText?.trim();
    if (text === undefined || text.length < MIN_SEARCHABLE_LENGTH) continue;

    const key = `${bucket.piiType}|${text.toLowerCase()}`;
    const confidence = fuseConfidence(bucket.detections);
    const previous = confirmed.get(key);
    if (
      previous !== undefined &&
      previous.confidence >= confidence &&
      previous.slot !== undefined
    ) {
      continue;
    }

    // A vault slot is strictly better information than none, so whichever bucket has
    // one wins regardless of which was seen first.
    const slot = bucket.slot ?? previous?.slot;

    confirmed.set(key, {
      piiType: bucket.piiType,
      text,
      confidence: Math.max(confidence, previous?.confidence ?? 0),
      ...(slot === undefined ? {} : { slot }),
    });
  }
  if (confirmed.size === 0) return;

  /** Is this location already covered for this type? */
  const covered = (
    piiType: PiiType,
    elementId: string | undefined,
    field: TextField | undefined,
    start: number,
    end: number,
    rect: Rect,
  ): boolean => buckets.has(bucketKey(piiType, elementId, field, { start, end }, rect));

  for (const value of confirmed.values()) {
    const pattern = searchPatternFor(value.piiType, value.text);
    if (pattern === undefined) continue;

    for (const node of graph.nodes) {
      for (const { field, text } of scannableText(node)) {
        // A fresh regex per string: `lastIndex` on a shared /g/ instance would make
        // this skip matches depending on what was scanned before it.
        const scan = new RegExp(pattern.source, pattern.flags);
        let match: RegExpExecArray | null;
        while ((match = scan.exec(text)) !== null) {
          const found = match[0];
          if (found === '') {
            scan.lastIndex++;
            continue;
          }
          const start = match.index;
          const end = start + found.length;
          const rect = rectForMatch(node, field, text.length, start, end);
          if (covered(value.piiType, node.id, field, start, end, rect)) continue;

          record(
            {
              id: nextId(),
              piiType: value.piiType,
              detector: value.slot === undefined ? 'pattern' : 'known_value',
              confidence: value.confidence,
              elementId: node.id,
              rect,
              span: { start, end },
              matchedText: found,
            },
            rect,
            {
              elementId: node.id,
              field,
              span: { start, end },
              ...(value.slot === undefined ? {} : { slot: value.slot }),
              matchedText: found,
            },
          );
        }
      }
    }

    // OCR words carry their own tight rectangle, which is better geometry than the
    // element-level interpolation above, so they are worth a second pass.
    for (const word of words) {
      const scan = new RegExp(pattern.source, pattern.flags);
      if (!scan.test(word.text)) continue;
      if (covered(value.piiType, undefined, undefined, 0, 0, word.rect)) continue;

      record(
        {
          id: nextId(),
          piiType: value.piiType,
          detector: value.slot === undefined ? 'pattern' : 'known_value',
          confidence: value.confidence * Math.max(0.5, word.confidence),
          rect: word.rect,
          matchedText: word.text,
        },
        word.rect,
        {
          ...(value.slot === undefined ? {} : { slot: value.slot }),
          matchedText: word.text,
        },
      );
    }
  }
}

/** Group OCR words into visual lines so tokens split at punctuation are scanned whole. */
function groupOcrLines(words: readonly OcrWord[]): OcrWord[][] {
  const lines: { words: OcrWord[]; centerY: number; height: number }[] = [];
  const sorted = [...words].sort(
    (a, b) =>
      a.rect.y + a.rect.height / 2 - (b.rect.y + b.rect.height / 2) || a.rect.x - b.rect.x,
  );

  for (const word of sorted) {
    const centerY = word.rect.y + word.rect.height / 2;
    let best: (typeof lines)[number] | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const line of lines) {
      const distance = Math.abs(centerY - line.centerY);
      if (distance > Math.max(4, Math.max(line.height, word.rect.height) * 0.65)) continue;
      if (distance < bestDistance) {
        best = line;
        bestDistance = distance;
      }
    }

    if (best === undefined) {
      lines.push({ words: [word], centerY, height: word.rect.height });
    } else {
      best.words.push(word);
      best.centerY =
        best.words.reduce((sum, item) => sum + item.rect.y + item.rect.height / 2, 0) /
        best.words.length;
      best.height = Math.max(best.height, word.rect.height);
    }
  }

  return lines.map((line) => line.words.sort((a, b) => a.rect.x - b.rect.x));
}

function boundsOfWords(words: readonly OcrWord[]): Rect {
  const left = Math.min(...words.map((word) => word.rect.x));
  const top = Math.min(...words.map((word) => word.rect.y));
  const right = Math.max(...words.map((word) => word.rect.x + word.rect.width));
  const bottom = Math.max(...words.map((word) => word.rect.y + word.rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function detectPii(input: DetectInput): DetectResult {
  const started = performance.now();
  const { graph, words = [], vault = [] } = input;

  const buckets = new Map<string, Bucket>();
  const byDetector: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let conflicts = 0;

  const record = (
    detection: PiiDetection,
    rect: Rect,
    extra: {
      elementId?: string;
      field?: TextField;
      span?: { start: number; end: number };
      slot?: string;
      matchedText?: string;
      conflicting?: boolean;
    },
  ): void => {
    const key = bucketKey(detection.piiType, extra.elementId, extra.field, extra.span, rect);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        piiType: detection.piiType,
        rect,
        detections: [],
        detectors: new Set(),
      };
      buckets.set(key, bucket);
    }
    bucket.detections.push(detection);
    bucket.detectors.add(detection.detector);
    if (extra.elementId !== undefined) bucket.elementId = extra.elementId;
    if (extra.field !== undefined) bucket.field = extra.field;
    if (extra.span !== undefined) bucket.span = extra.span;
    // A vault slot is strictly better information than none, so it wins.
    if (extra.slot !== undefined) bucket.slot = extra.slot;
    if (extra.matchedText !== undefined) bucket.matchedText = extra.matchedText;
    if (extra.conflicting === true) bucket.conflicting = true;

    byDetector[detection.detector] = (byDetector[detection.detector] ?? 0) + 1;
  };

  let counter = 0;
  const nextId = (): string => `pii_${String(counter++)}`;

  // ---- Elements ---------------------------------------------------------
  for (const node of graph.nodes) {
    // Layer 2: what the markup declares about the field, value or not.
    const structural = classifyElement(node);
    const conflicting = hasConflictingSignals(structural);
    if (conflicting) conflicts++;

    for (const finding of structural) {
      record(
        {
          id: nextId(),
          piiType: finding.piiType,
          detector: 'structural',
          confidence: finding.confidence,
          elementId: node.id,
          rect: node.rect,
        },
        node.rect,
        { elementId: node.id, conflicting },
      );
    }

    // Layers 1 and 3 need text to work on.
    const context = contextFor(node);
    for (const { field, text } of scannableText(node)) {
      for (const match of findKnownValues(text, vault)) {
        const rect = rectForMatch(node, field, text.length, match.start, match.end);
        record(
          {
            id: nextId(),
            piiType: match.piiType,
            detector: 'known_value',
            confidence: match.confidence,
            elementId: node.id,
            rect,
            span: { start: match.start, end: match.end },
            matchedText: match.text,
          },
          rect,
          {
            elementId: node.id,
            field,
            span: { start: match.start, end: match.end },
            slot: match.slot,
            matchedText: match.text,
          },
        );
      }

      for (const match of findPatterns(text, context)) {
        const rect = rectForMatch(node, field, text.length, match.start, match.end);
        record(
          {
            id: nextId(),
            piiType: match.piiType,
            detector: 'pattern',
            confidence: match.confidence,
            elementId: node.id,
            rect,
            span: { start: match.start, end: match.end },
            matchedText: match.text,
          },
          rect,
          {
            elementId: node.id,
            field,
            span: { start: match.start, end: match.end },
            matchedText: match.text,
          },
        );
      }
    }

    // Visual PII: a detected face is not something to click, it is something to
    // cover. The detector label is the only signal available here.
    const label = (node.detectorMeta as { label?: unknown } | undefined)?.label;
    const visualType = typeof label === 'string' ? visualPiiType(label) : undefined;
    if (visualType !== undefined) {
      record(
        {
          id: nextId(),
          piiType: visualType,
          detector: 'vision_face',
          confidence: node.confidence,
          elementId: node.id,
          rect: node.rect,
        },
        node.rect,
        { elementId: node.id },
      );
    }
  }

  // ---- OCR words --------------------------------------------------------
  // Words that fusion could not attach to any element still need scanning: text
  // baked into a background image belongs to no element but is just as sensitive.
  // These carry their own tight rectangle, which is better geometry than the
  // element-level interpolation above.
  for (const word of words) {
    for (const match of findKnownValues(word.text, vault)) {
      record(
        {
          id: nextId(),
          piiType: match.piiType,
          detector: 'known_value',
          confidence: match.confidence,
          rect: word.rect,
          matchedText: match.text,
        },
        word.rect,
        { slot: match.slot, matchedText: match.text },
      );
    }
    for (const match of findPatterns(word.text)) {
      record(
        {
          id: nextId(),
          piiType: match.piiType,
          detector: 'pattern',
          // OCR can misread characters, and a misread digit fails a checksum. So
          // the recognition confidence is folded in rather than trusted.
          confidence: match.confidence * Math.max(0.5, word.confidence),
          rect: word.rect,
          matchedText: match.text,
        },
        word.rect,
        { matchedText: match.text },
      );
    }
  }

  // OCR engines frequently split a key around hyphens or punctuation. Scan each
  // visual line both as normal text and as a compact token, and conservatively mask
  // the whole line when either representation contains a secret.
  for (const line of groupOcrLines(words)) {
    if (line.length === 0) continue;
    const rect = boundsOfWords(line);
    const confidence = line.reduce((sum, word) => sum + word.confidence, 0) / line.length;
    const variants = new Set([
      line.map((word) => word.text).join(' '),
      line.map((word) => word.text).join(''),
    ]);

    for (const text of variants) {
      for (const match of findKnownValues(text, vault)) {
        record(
          {
            id: nextId(),
            piiType: match.piiType,
            detector: 'known_value',
            confidence: Math.max(0.5, confidence),
            rect,
            span: { start: match.start, end: match.end },
            matchedText: match.text,
          },
          rect,
          {
            field: 'ocr',
            span: { start: match.start, end: match.end },
            slot: match.slot,
            matchedText: match.text,
          },
        );
      }

      for (const match of findPatterns(text)) {
        record(
          {
            id: nextId(),
            piiType: match.piiType,
            detector: 'pattern',
            confidence: match.confidence * Math.max(0.5, confidence),
            rect,
            span: { start: match.start, end: match.end },
            matchedText: match.text,
          },
          rect,
          {
            field: 'ocr',
            span: { start: match.start, end: match.end },
            matchedText: match.text,
          },
        );
      }
    }
  }

  // ---- Propagate confirmed values --------------------------------------
  // Detection is per-location, but a value is a value. A portal shows the same roll
  // number in the header, the sidebar, and every table row; the pattern layer may
  // only fire on one of them because only one had the label next to it that made it
  // recognisable. The others are then still visible in the screenshot.
  //
  // So once any layer has confirmed a literal, that literal is searched for
  // everywhere, using the same separator-tolerant matching the detector used to find
  // it. This is cheap — a handful of confirmed strings against text already in
  // memory — and it is what makes the pixel side as complete as the text side.
  propagateConfirmedValues(buckets, graph, words, record, nextId);

  // ---- Fuse and apply policy -------------------------------------------
  const findings: PiiFinding[] = [];
  let belowThreshold = 0;

  for (const bucket of buckets.values()) {
    const confidence = fuseConfidence(bucket.detections);
    if (!shouldRedact(bucket.piiType, confidence)) {
      belowThreshold++;
      continue;
    }

    // `resolveRedactionMode` is what downgrades a blur request to a solid mask for
    // anything high-value. Blur is partially reversible on structured text, so
    // this must not be bypassed.
    const redaction = resolveRedactionMode(bucket.piiType, policyFor(bucket.piiType).redaction);

    findings.push({
      id: nextId(),
      piiType: bucket.piiType,
      confidence,
      redaction,
      rect: bucket.rect,
      detectors: [...bucket.detectors].sort(),
      ...(bucket.elementId === undefined ? {} : { elementId: bucket.elementId }),
      ...(bucket.field === undefined ? {} : { field: bucket.field }),
      ...(bucket.span === undefined ? {} : { span: bucket.span }),
      ...(bucket.slot === undefined ? {} : { slot: bucket.slot }),
      ...(bucket.matchedText === undefined ? {} : { matchedText: bucket.matchedText }),
      ...(bucket.conflicting === true ? { conflicting: true } : {}),
    });

    byType[bucket.piiType] = (byType[bucket.piiType] ?? 0) + 1;
  }

  findings.sort((a, b) => b.confidence - a.confidence);

  return {
    findings,
    stats: {
      elementsScanned: graph.nodes.length,
      wordsScanned: words.length,
      byDetector,
      byType,
      belowThreshold,
      conflicts,
      durationMs: performance.now() - started,
    },
  };
}
