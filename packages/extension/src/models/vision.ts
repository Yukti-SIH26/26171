/**
 * The pixel channel.
 *
 * Takes a screenshot and produces element candidates using only what is visible,
 * with no access to markup. That independence is the entire point: it is what
 * lets the agent work on canvas apps, image-only buttons, and the unlabelled
 * `<div>` soup that most real sites are built from.
 *
 * Zero-shot detection means the "training" for UI understanding is a list of
 * English phrases in the catalogue. That is crude, and it is the honest reason a
 * fine-tuned detector is still on the roadmap. What matters now is that the
 * pipeline around it — fusion, redaction, the privacy firewall — is built so the
 * detector can be swapped without touching anything else.
 */

import {
  pipeline,
  RawImage,
  type ZeroShotObjectDetectionPipeline,
} from '@huggingface/transformers';
import type { BrowserCapabilities, Rect } from '@sih/core';
import { configureEnv, type Device } from './env.ts';
export type { Device };
import { ProgressTracker, type LoadProgress } from './progress.ts';
import { UI_QUERIES, type ModelSpec } from './catalogue.ts';
import { recognize, type OcrWord } from './ocr.ts';

export interface DetectedRegion {
  readonly label: string;
  readonly score: number;
  /** CSS pixel coordinates, already divided by devicePixelRatio. */
  readonly rect: Rect;
}

export interface PixelObservation {
  readonly regions: readonly DetectedRegion[];
  readonly words: readonly OcrWord[];
  readonly detectMs: number;
  readonly ocrMs: number;
  readonly device: Device;
  readonly imageWidth: number;
  readonly imageHeight: number;
}

/** Below this the zero-shot detector produces mostly noise on UI screenshots. */
const MIN_DETECTION_SCORE = 0.08;
/** Bound on emitted regions, so one bad frame cannot flood the graph. */
const MAX_REGIONS = 120;

let detector: ZeroShotObjectDetectionPipeline | undefined;
let detectorKey: string | undefined;
/** Backend the loaded detector actually runs on, which is not always the one asked for. */
let activeDevice: Device | undefined;
let loadingPromise: Promise<ZeroShotObjectDetectionPipeline> | undefined;

export interface LoadOptions {
  readonly capabilities: BrowserCapabilities;
  readonly spec: ModelSpec;
  readonly onProgress?: (progress: LoadProgress) => void;
}

/**
 * Load the detector.
 *
 * Concurrency-safe: simultaneous callers share one load rather than each pulling
 * their own copy of the weights, which on a 4 GB machine would be fatal.
 */
export async function loadDetector(
  options: LoadOptions,
): Promise<ZeroShotObjectDetectionPipeline> {
  if (detector !== undefined && detectorKey === options.spec.key) return detector;
  if (loadingPromise !== undefined) return loadingPromise;

  // Called for its side effect: this is what pins the local model root and the local
  // ORT binary. The device it reports is advisory only — see the load call below.
  configureEnv(options.capabilities);
  const tracker = new ProgressTracker(
    options.spec.key,
    options.onProgress ?? ((): void => undefined),
  );

  loadingPromise = (async (): Promise<ZeroShotObjectDetectionPipeline> => {
    try {
      // Release any previously loaded detector first; holding two is the fastest
      // way to exhaust memory on a low-RAM machine.
      if (detector !== undefined) {
        await detector.dispose();
        detector = undefined;
        detectorKey = undefined;
      }

      const create = async (on: Device): Promise<ZeroShotObjectDetectionPipeline> =>
        (await pipeline('zero-shot-object-detection', options.spec.repo, {
          device: on,
          // Fixed by whatever was bundled. There is no other file on disk, so
          // asking for a different precision would simply 404.
          dtype: options.spec.quantization,
          // The weights live in sibling `.onnx_data` files so no single committed
          // file exceeds GitHub's 100 MiB limit. transformers.js derives their
          // names from this count; a mismatch here is a load failure.
          use_external_data_format: options.spec.externalDataChunks,
          // Belt and braces alongside `env.allowRemoteModels = false`: this makes
          // the intent explicit at the call site too.
          local_files_only: true,
          progress_callback: tracker.handle,
        })) as ZeroShotObjectDetectionPipeline;

      // The CPU backend, regardless of what the capability probe reports.
      //
      // Two separate reasons, both measured rather than assumed:
      //
      //  - The bundled ORT binary is the CPU build. It is the only one whose kernel set
      //    covers this graph; the asyncify build has no `Cast(13)`, which is the node in
      //    OWL-ViT's classification head that kept the detector from ever loading.
      //  - Asking for WebGPU hands ORT a provider list with no CPU member, so any node
      //    its kernels miss is left unassigned and partitioning aborts outright.
      const created = await create('wasm');
      activeDevice = 'wasm';

      tracker.markReady();
      detector = created;
      detectorKey = options.spec.key;
      return created;
    } catch (error) {
      tracker.markFailed(error);
      throw error;
    } finally {
      loadingPromise = undefined;
    }
  })();

  return loadingPromise;
}

interface RawDetection {
  label?: string;
  score?: number;
  box?: { xmin?: number; ymin?: number; xmax?: number; ymax?: number };
}

function toRegions(raw: unknown, dpr: number): DetectedRegion[] {
  if (!Array.isArray(raw)) return [];

  const out: DetectedRegion[] = [];
  for (const item of raw as RawDetection[]) {
    const score = item.score ?? 0;
    const box = item.box;
    if (score < MIN_DETECTION_SCORE || box === undefined) continue;

    const xmin = box.xmin ?? 0;
    const ymin = box.ymin ?? 0;
    const width = (box.xmax ?? 0) - xmin;
    const height = (box.ymax ?? 0) - ymin;
    if (width <= 1 || height <= 1) continue;

    out.push({
      label: item.label ?? 'unknown',
      score,
      // Model works in device pixels; the element graph is in CSS pixels.
      rect: { x: xmin / dpr, y: ymin / dpr, width: width / dpr, height: height / dpr },
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, MAX_REGIONS);
}

// ---------------------------------------------------------------------------
// Reading only the parts of the frame that need reading
// ---------------------------------------------------------------------------

/** Pixels of slack around each crop, so a glyph at the edge is not cut in half. */
const CROP_PAD = 8;

/** Above this share of the frame, one full-frame pass is cheaper than the crops. */
const CROP_AREA_LIMIT = 0.55;

/** More crops than this and the per-pass overhead outweighs the saving. */
const MAX_CROPS = 6;

interface OcrOutcome {
  readonly words: readonly OcrWord[];
  readonly fullText: string;
  readonly durationMs: number;
}

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * Collapse overlapping regions into as few rectangles as possible.
 *
 * Two passes, because a union can come to touch a rectangle it did not overlap before it
 * grew. Two is enough in practice and bounded, which an until-stable loop is not.
 */
function mergeRegions(regions: readonly Rect[]): Rect[] {
  let current = regions.map((r) => ({
    x: r.x - CROP_PAD,
    y: r.y - CROP_PAD,
    width: r.width + CROP_PAD * 2,
    height: r.height + CROP_PAD * 2,
  }));

  for (let pass = 0; pass < 2; pass++) {
    const out: Rect[] = [];
    for (const region of current) {
      const hit = out.findIndex((existing) => intersects(existing, region));
      if (hit === -1) out.push(region);
      else out[hit] = union(out[hit] as Rect, region);
    }
    if (out.length === current.length) return out;
    current = out;
  }

  return current;
}

/**
 * Recognise text inside specific parts of the frame.
 *
 * Full-frame OCR on a 1150x722 screenshot costs on the order of a second, and it was
 * paid on every step of every run. Almost all of that frame is text the DOM already
 * described perfectly; the only part OCR is uniquely needed for is the part painted as
 * pixels. So the caller says where those are and only they are read.
 *
 * Falls back to the whole frame rather than failing, in three cases: no `document` to
 * make a canvas with, too many separate regions, or regions covering most of the frame.
 * Falling back is always safe — it reads strictly more — so every failure here costs
 * time rather than coverage.
 */
async function recognizeRegions(
  dataUrl: string,
  regions: readonly Rect[],
  dpr: number,
  capabilities: BrowserCapabilities,
  onProgress?: (message: string, fraction: number | null) => void,
): Promise<OcrOutcome> {
  const whole = async (): Promise<OcrOutcome> => recognize(dataUrl, capabilities, onProgress);

  if (regions.length === 0 || regions.length > MAX_CROPS) return whole();
  if (typeof document === 'undefined') return whole();

  const started = performance.now();

  let bitmap: ImageBitmap;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    bitmap = await createImageBitmap(blob);
  } catch {
    return whole();
  }

  try {
    // Regions arrive in CSS pixels; the frame is in device pixels.
    const scaled = regions.map((r) => ({
      x: r.x * dpr,
      y: r.y * dpr,
      width: r.width * dpr,
      height: r.height * dpr,
    }));

    const clipped: Rect[] = [];
    for (const region of mergeRegions(scaled)) {
      const x = Math.max(0, Math.floor(region.x));
      const y = Math.max(0, Math.floor(region.y));
      const width = Math.min(bitmap.width - x, Math.ceil(region.width));
      const height = Math.min(bitmap.height - y, Math.ceil(region.height));
      // Tesseract needs something to work with; a sliver is noise.
      if (width >= 16 && height >= 10) clipped.push({ x, y, width, height });
    }

    if (clipped.length === 0) return { words: [], fullText: '', durationMs: 0 };

    const frameArea = bitmap.width * bitmap.height;
    const cropArea = clipped.reduce((sum, r) => sum + r.width * r.height, 0);
    if (frameArea > 0 && cropArea / frameArea > CROP_AREA_LIMIT) return whole();

    const words: OcrWord[] = [];
    const texts: string[] = [];

    for (const region of clipped) {
      const canvas = document.createElement('canvas');
      canvas.width = region.width;
      canvas.height = region.height;
      const ctx = canvas.getContext('2d');
      if (ctx === null) return whole();
      ctx.drawImage(
        bitmap,
        region.x,
        region.y,
        region.width,
        region.height,
        0,
        0,
        region.width,
        region.height,
      );

      const result = await recognize(canvas, capabilities, onProgress);
      texts.push(result.fullText);
      // Back into full-frame device pixels, which is what the caller's dpr division and
      // the redaction painter both expect.
      for (const word of result.words) {
        words.push({
          ...word,
          rect: {
            x: word.rect.x + region.x,
            y: word.rect.y + region.y,
            width: word.rect.width,
            height: word.rect.height,
          },
        });
      }
    }

    return { words, fullText: texts.join('\n'), durationMs: performance.now() - started };
  } finally {
    bitmap.close();
  }
}

export interface ObserveOptions {
  readonly dataUrl: string;
  readonly devicePixelRatio: number;
  readonly capabilities: BrowserCapabilities;
  readonly queries?: readonly string[];
  readonly runOcr?: boolean;
  /**
   * Parts of the frame, in CSS pixels, that are painted rather than described by the DOM.
   *
   * Absent means "read the whole frame". An empty array is not the same thing and is not
   * accepted as one: the caller decides whether OCR runs at all via `runOcr`, so passing
   * regions is always a narrowing of a pass that is already happening.
   */
  readonly ocrRegions?: readonly Rect[];
  /**
   * Run the object detector.
   *
   * Defaults to true. Turning it off is an accuracy trade, never a privacy one: the
   * detector finds *controls* in pixels the DOM did not describe, and it reads no text.
   * The pass that makes sending a frame safe is OCR, which is governed separately.
   */
  readonly runDetector?: boolean;
  readonly onOcrProgress?: (message: string, fraction: number | null) => void;
}

/**
 * Run the pixel channel over a screenshot.
 *
 * Detection and OCR are independent, so they run concurrently. On a 4-core
 * machine that overlap is a meaningful share of the latency budget.
 */
export async function observePixels(options: ObserveOptions): Promise<PixelObservation> {
  const runDetector = options.runDetector !== false;
  if (runDetector && detector === undefined) {
    throw new Error('detector is not loaded; call loadDetector() first');
  }

  const { device } = configureEnv(options.capabilities);
  const queries = options.queries ?? UI_QUERIES;
  const dpr = options.devicePixelRatio <= 0 ? 1 : options.devicePixelRatio;

  // Decoding the frame into a tensor is only worth doing when something will consume it.
  const image = runDetector ? await RawImage.fromURL(options.dataUrl) : undefined;

  const detectStarted = performance.now();
  const detectPromise =
    image === undefined || detector === undefined
      ? Promise.resolve([])
      : detector(image, [...queries], {
          threshold: MIN_DETECTION_SCORE,
          percentage: false,
        });

  const ocrPromise =
    options.runOcr === true
      ? recognizeRegions(
          options.dataUrl,
          options.ocrRegions ?? [],
          dpr,
          options.capabilities,
          options.onOcrProgress,
        )
      : Promise.resolve<OcrOutcome>({ words: [], fullText: '', durationMs: 0 });

  const [rawDetections, ocr] = await Promise.all([detectPromise, ocrPromise]);
  const detectMs = runDetector ? performance.now() - detectStarted : 0;

  // OCR boxes are in image pixels too, so they need the same conversion.
  const words: OcrWord[] =
    dpr === 1
      ? [...ocr.words]
      : ocr.words.map((w) => ({
          ...w,
          rect: {
            x: w.rect.x / dpr,
            y: w.rect.y / dpr,
            width: w.rect.width / dpr,
            height: w.rect.height / dpr,
          },
        }));

  return {
    regions: toRegions(rawDetections, dpr),
    words,
    detectMs,
    ocrMs: ocr.durationMs,
    device,
    // Zero when the detector was skipped, because then the frame was never decoded into a
    // tensor and there is no measured size to report. The caller already knows the
    // screenshot's dimensions from the capture; these are diagnostic only.
    imageWidth: image?.width ?? 0,
    imageHeight: image?.height ?? 0,
  };
}

export function isDetectorLoaded(): boolean {
  return detector !== undefined;
}

export function loadedDetectorKey(): string | undefined {
  return detectorKey;
}

/** Which backend the detector is actually running on, once loaded. */
export function loadedDetectorDevice(): Device | undefined {
  return activeDevice;
}

/** Free the detector's memory, which is scored. */
export async function disposeDetector(): Promise<void> {
  const active = detector;
  detector = undefined;
  detectorKey = undefined;
  activeDevice = undefined;
  if (active !== undefined) await active.dispose();
}
