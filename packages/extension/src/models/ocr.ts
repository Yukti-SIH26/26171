/**
 * OCR via Tesseract.js.
 *
 * The pixel channel needs to read text that has no DOM representation: canvas
 * renderings, scanned marksheets, ID card photographs, text baked into images.
 * Tesseract.js is the only OCR engine that runs in a browser without an ONNX
 * conversion step, which is why it is here rather than a transformer OCR model.
 *
 * Word-level boxes are what matter, not the transcript. A redaction needs to know
 * *where* the Aadhaar number is in pixel space, not merely that the page contains
 * one somewhere.
 *
 * Known limitation, stated rather than hidden: English is good on crisp rendered
 * text and materially worse on Devanagari and other Indian scripts. A regional
 * language portal will have lower OCR recall.
 */

import { createWorker, type Page, type Word, type Worker } from 'tesseract.js';
import type { BrowserCapabilities, Rect } from '@sih/core';

export interface OcrWord {
  readonly text: string;
  readonly rect: Rect;
  /** Tesseract confidence, normalised to 0..1. */
  readonly confidence: number;
}

export interface OcrResult {
  readonly words: readonly OcrWord[];
  readonly fullText: string;
  readonly durationMs: number;
}

/** Below this, Tesseract output is usually noise and costs precision. */
const MIN_WORD_CONFIDENCE = 0.4;

let worker: Worker | undefined;
let initPromise: Promise<Worker> | undefined;

/**
 * Resolve an extension-relative path to an absolute extension URL.
 *
 * Written against the callable shape rather than importing a browser polyfill so
 * this module stays loadable in Node, where no extension APIs exist.
 */
function extensionUrl(path: string): string {
  const globals = globalThis as {
    chrome?: { runtime?: { getURL?: (p: string) => string } };
    browser?: { runtime?: { getURL?: (p: string) => string } };
  };
  const getURL = globals.chrome?.runtime?.getURL ?? globals.browser?.runtime?.getURL;
  return typeof getURL === 'function' ? getURL(path) : path;
}

/**
 * Start the OCR worker.
 *
 * Every path here points inside the extension, for two separate reasons:
 *
 *  - MV3's `script-src 'self'` forbids running a worker from a `blob:` URL,
 *    which is tesseract.js's default. Pointing `workerPath` at a real bundled
 *    file with `workerBlobURL: false` is the only way this starts at all.
 *  - The core wasm and the language data would otherwise be fetched from
 *    jsDelivr on first use, which would break the offline guarantee.
 *
 * Idempotent and concurrency-safe: two simultaneous callers share one worker
 * rather than racing to create two, which would double the ~180 MiB cost.
 */
export async function ensureOcrWorker(
  capabilities?: BrowserCapabilities,
  onProgress?: (message: string, fraction: number | null) => void,
): Promise<Worker> {
  if (worker !== undefined) return worker;
  if (initPromise !== undefined) return initPromise;

  // SIMD roughly halves recognition time. The non-SIMD build is bundled too,
  // because a wrong guess here is a hard load failure rather than a slowdown.
  const simd = capabilities?.wasm.simd ?? false;
  const corePath = extensionUrl(
    simd
      ? 'tesseract/tesseract-core-simd-lstm.wasm.js'
      : 'tesseract/tesseract-core-lstm.wasm.js',
  );

  initPromise = (async (): Promise<Worker> => {
    // `oem` left at the library default (LSTM_ONLY) rather than importing the
    // enum, so nothing here depends on the shape of a runtime export.
    const created = await createWorker('eng', undefined, {
      workerPath: extensionUrl('tesseract/worker.min.js'),
      workerBlobURL: false,
      corePath,
      // Directory, not a file: tesseract appends `<lang>.traineddata.gz`.
      langPath: extensionUrl('tesseract/'),
      gzip: true,
      logger: (m: { status?: string; progress?: number }) => {
        if (onProgress === undefined) return;
        onProgress(m.status ?? 'loading', typeof m.progress === 'number' ? m.progress : null);
      },
    });
    worker = created;
    return created;
  })();

  try {
    return await initPromise;
  } catch (error) {
    initPromise = undefined;
    throw error;
  }
}

/**
 * Pull word boxes out of a recognition result.
 *
 * Words are nested four levels deep — `blocks > paragraphs > lines > words` —
 * and only exist when `blocks: true` was requested. `blocks` is legitimately
 * `null` when the output format was not asked for, so an empty list here means
 * "no geometry requested", not "no text found".
 */
export function wordsFromPage(page: Pick<Page, 'blocks'>): OcrWord[] {
  const out: OcrWord[] = [];
  if (page.blocks === null) return out;

  for (const block of page.blocks) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          const converted = toWord(word);
          if (converted !== undefined) out.push(converted);
        }
      }
    }
  }
  return out;
}

function toWord(word: Word): OcrWord | undefined {
  const text = word.text.trim();
  if (text === '') return undefined;

  // Tesseract reports 0..100; the rest of the codebase uses 0..1 everywhere so
  // that detector scores and OCR scores can be compared without a unit bug.
  const confidence = word.confidence / 100;
  if (confidence < MIN_WORD_CONFIDENCE) return undefined;

  const { bbox } = word;
  const width = bbox.x1 - bbox.x0;
  const height = bbox.y1 - bbox.y0;
  if (width <= 0 || height <= 0) return undefined;

  return { text, confidence, rect: { x: bbox.x0, y: bbox.y0, width, height } };
}

/**
 * Recognise text in an image.
 *
 * Coordinates come back in the image's own pixel space. The caller divides by
 * devicePixelRatio to land back in CSS pixels, which is the space the element
 * graph and the redaction overlay both use.
 */
export async function recognize(
  image: string | Blob | HTMLCanvasElement,
  capabilities?: BrowserCapabilities,
  onProgress?: (message: string, fraction: number | null) => void,
): Promise<OcrResult> {
  const started = performance.now();
  const active = await ensureOcrWorker(capabilities, onProgress);

  // `blocks: true` is required for word-level geometry; without it Tesseract
  // returns only the transcript, which is useless for pixel redaction.
  const { data } = await active.recognize(image, {}, { text: true, blocks: true });

  return {
    words: wordsFromPage(data),
    fullText: data.text,
    durationMs: performance.now() - started,
  };
}

/** Release the worker and its ~180 MB. */
export async function disposeOcrWorker(): Promise<void> {
  const active = worker;
  worker = undefined;
  initPromise = undefined;
  if (active !== undefined) await active.terminate();
}

export function isOcrReady(): boolean {
  return worker !== undefined;
}
