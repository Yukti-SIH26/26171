/**
 * Channel fusion.
 *
 * Merges the structure channel (DOM/ARIA) with the pixel channel (vision models)
 * into one element graph. They are peers, not a primary and a fallback, and the
 * merge is where their complementary blind spots cancel out:
 *
 *   both agree        -> highest confidence; the pixel channel confirms the box
 *                        is really rendered where the DOM claims
 *   structure only    -> real but visually unremarkable, or covered. Kept: the
 *                        DOM is authoritative about existence.
 *   pixel only        -> something is there that the markup never declared.
 *                        Canvas, image button, div soup. This is the whole
 *                        reason the pixel channel exists.
 *
 * OCR words are attached to whichever element contains them, which is what gives
 * the PII detectors text to scan on elements whose content is pure pixels.
 */

import {
  computeStats,
  containment,
  iou,
  type ElementGraph,
  type ElementNode,
  type Rect,
} from '@sih/core';
import type { DetectedRegion } from '../models/vision.ts';
import type { OcrWord } from '../models/ocr.ts';
import { queryToRole } from '../models/catalogue.ts';

/**
 * IoU at which a detection is considered the same thing as a DOM element.
 *
 * Deliberately lenient. A detector box around a button rarely aligns with the
 * DOM box: padding, borders, and the model's own imprecision all shift it. Too
 * strict and every real element gets duplicated as a phantom pixel-only node.
 */
const FUSE_IOU_THRESHOLD = 0.45;

/**
 * Alternative match test: the detection sits almost entirely inside a DOM
 * element. Catches the common case of a tight box on an icon inside a larger
 * button, where IoU is poor but the association is obvious.
 */
const FUSE_CONTAINMENT_THRESHOLD = 0.75;

/** A pixel-only candidate smaller than this is almost always detector noise. */
const MIN_PIXEL_ONLY_AREA = 120;

/** OCR word must be mostly inside an element to be treated as its text. */
const WORD_CONTAINMENT_THRESHOLD = 0.6;

export interface FusionInput {
  readonly structure: ElementGraph;
  readonly regions: readonly DetectedRegion[];
  readonly words: readonly OcrWord[];
}

export interface FusionStats {
  readonly agreed: number;
  readonly structureOnly: number;
  readonly pixelOnly: number;
  readonly wordsAttached: number;
  readonly wordsUnattached: number;
  readonly durationMs: number;
}

export interface FusionResult {
  readonly graph: ElementGraph;
  readonly stats: FusionStats;
}

function matches(region: Rect, element: Rect): boolean {
  if (iou(region, element) >= FUSE_IOU_THRESHOLD) return true;
  return containment(region, element) >= FUSE_CONTAINMENT_THRESHOLD;
}

/**
 * Best DOM element for a detection.
 *
 * Prefers the *smallest* qualifying element rather than the best-scoring one. A
 * detection inside a button that sits inside a form that sits inside a section
 * qualifies against all three; the button is the useful answer, and the smallest
 * container is reliably the most specific one.
 */
function bestMatch(region: Rect, candidates: readonly ElementNode[]): ElementNode | undefined {
  let best: ElementNode | undefined;
  let bestArea = Number.POSITIVE_INFINITY;

  for (const node of candidates) {
    if (node.flags.hidden) continue;
    if (!matches(region, node.rect)) continue;

    const nodeArea = node.rect.width * node.rect.height;
    if (nodeArea < bestArea) {
      best = node;
      bestArea = nodeArea;
    }
  }
  return best;
}

/** Smallest element containing an OCR word, so text lands on the leaf. */
function ownerOfWord(
  word: OcrWord,
  candidates: readonly ElementNode[],
): ElementNode | undefined {
  let best: ElementNode | undefined;
  let bestArea = Number.POSITIVE_INFINITY;

  for (const node of candidates) {
    if (containment(word.rect, node.rect) < WORD_CONTAINMENT_THRESHOLD) continue;
    const nodeArea = node.rect.width * node.rect.height;
    if (nodeArea > 0 && nodeArea < bestArea) {
      best = node;
      bestArea = nodeArea;
    }
  }
  return best;
}

export function fuseChannels(input: FusionInput): FusionResult {
  const started = performance.now();
  const { structure, regions, words } = input;

  const nodes: ElementNode[] = structure.nodes.map((n) => ({ ...n }));
  const byId = new Map<string, number>();
  nodes.forEach((n, i) => byId.set(n.id, i));

  let agreed = 0;
  let pixelOnly = 0;

  // ---- Detections -------------------------------------------------------
  for (const region of regions) {
    const match = bestMatch(region.rect, nodes);

    if (match !== undefined) {
      const index = byId.get(match.id);
      if (index === undefined) continue;
      const existing = nodes[index];
      if (existing === undefined) continue;

      // Already confirmed by an earlier detection; keep the stronger score.
      const previous = existing.detectorMeta as { score?: number } | undefined;
      const previousScore = typeof previous?.score === 'number' ? previous.score : 0;
      if (existing.source === 'fused' && previousScore >= region.score) continue;
      if (existing.source !== 'fused') agreed++;

      nodes[index] = {
        ...existing,
        source: 'fused',
        // Structure-channel certainty is preserved; visual confirmation is extra
        // evidence, so it must never lower confidence in a verified DOM node.
        confidence: 1,
        detectorMeta: {
          ...(existing.detectorMeta ?? {}),
          label: region.label,
          score: region.score,
          visuallyConfirmed: true,
        },
      };
      continue;
    }

    // Nothing in the DOM here. Either the markup is opaque (canvas, image
    // button) or the detector hallucinated. Small boxes are usually the latter.
    const area = region.rect.width * region.rect.height;
    if (area < MIN_PIXEL_ONLY_AREA) continue;

    const role = queryToRole(region.label);
    nodes.push({
      id: `px_${String(pixelOnly)}`,
      role,
      name: '',
      rect: region.rect,
      source: 'pixel',
      confidence: region.score,
      flags: {
        interactive: role !== 'generic' && role !== 'img',
        focusable: false,
        editable: role === 'textbox' || role === 'searchbox',
        disabled: false,
        hidden: false,
        inViewport: true,
        obscured: false,
      },
      detectorMeta: { label: region.label, score: region.score, pixelOnly: true },
    });
    pixelOnly++;
  }

  // ---- OCR text ---------------------------------------------------------
  const collected = new Map<number, string[]>();
  let wordsAttached = 0;
  let wordsUnattached = 0;

  for (const word of words) {
    const owner = ownerOfWord(word, nodes);
    if (owner === undefined) {
      wordsUnattached++;
      continue;
    }
    const index = nodes.findIndex((n) => n.id === owner.id);
    if (index < 0) {
      wordsUnattached++;
      continue;
    }
    const bucket = collected.get(index) ?? [];
    bucket.push(word.text);
    collected.set(index, bucket);
    wordsAttached++;
  }

  for (const [index, parts] of collected) {
    const node = nodes[index];
    if (node === undefined) continue;
    const ocrText = parts.join(' ').trim();
    if (ocrText === '') continue;

    nodes[index] = {
      ...node,
      // Kept separate from `text`: DOM text is authoritative, OCR text is
      // inferred and carries recognition errors. Conflating them would let an
      // OCR mistake overwrite a known-good value.
      detectorMeta: { ...(node.detectorMeta ?? {}), ocrText },
      ...(node.text === undefined ? { text: ocrText } : {}),
    };
  }

  const structureOnly = nodes.filter((n) => n.source === 'structure').length;

  return {
    graph: {
      ...structure,
      nodes,
      stats: computeStats(nodes),
    },
    stats: {
      agreed,
      structureOnly,
      pixelOnly,
      wordsAttached,
      wordsUnattached,
      durationMs: performance.now() - started,
    },
  };
}
