/**
 * Screenshot of the tab the agent is working in.
 *
 * `tabs.captureVisibleTab`, which needs the `<all_urls>` host permission. That was
 * previously avoided in favour of `getDisplayMedia`, and the reasoning does not
 * survive contact with the rest of this extension: `entrypoints/content.ts` is
 * declared `matches: ['<all_urls>']`, so the full DOM of every page is already read.
 * Withholding the host permission for *pixels* while already reading all the *text*
 * bought no privacy at all. What it cost was real:
 *
 *   - a surface picker on every session, and a browser-level sharing bar on screen
 *     for the whole task
 *   - the user choosing a window or a monitor, whose frame contains the OS, the
 *     browser chrome, and this panel, so element coordinates line up with nothing.
 *     `displaySurface: 'browser'` is only a hint and no option removes "Window"
 *     from the picker, so this was unpreventable rather than unlikely
 *   - a whole misalignment-detection path that existed only to refuse those frames
 *
 * This API has none of that. It returns exactly the visible viewport of exactly the
 * tab we name, so alignment is a property of the API rather than something we
 * measure and hope for. One permission notice at install, then never again.
 *
 * Two real constraints remain, and both are handled here rather than surfaced:
 *
 *  - **Chrome throttles it.** Roughly two calls a second; beyond that it rejects
 *    with a quota message. An agent stepping quickly will hit this, and it is a
 *    wait-and-retry condition, not a failure.
 *  - **Some pages cannot be captured at all.** `chrome://`, the Web Store, PDF
 *    viewers. Callers degrade to the text channel, so this throws a typed error
 *    instead of returning a blank frame.
 */

import { browser } from 'wxt/browser';
import type { CaptureAdapter, CapturedFrame, CaptureOptions, ImageFormat } from '@sih/core';

const DEFAULT_QUALITY = 82;

/** Chrome's limit is 2/second. Retry a few times, backing off past it. */
const THROTTLE_RETRIES = 4;
const THROTTLE_BACKOFF_MS = 320;

export class CaptureBlockedError extends Error {
  constructor(cause: string) {
    super(cause);
    this.name = 'CaptureBlockedError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Is this the rate limiter rather than a real refusal?
 *
 * Matched on the message because neither browser gives a code. Both use the
 * `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` wording, and Firefox says "too many".
 */
function isThrottled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|too many|quota/i.test(message);
}

/**
 * Turn a capture rejection into something a person can act on.
 *
 * The common causes are all "this page is not capturable", and saying which one it
 * is matters: a user who thinks the extension is broken will not think to switch
 * tabs off a settings page.
 */
function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';

  if (/cannot be scripted|cannot access|extension manifest|chrome:\/\/|about:/i.test(message)) {
    return (
      'This tab is a browser page, which no extension is allowed to photograph. ' +
      'Open a website first.'
    );
  }
  if (/permission/i.test(message)) {
    return (
      'Screenshot permission was not granted. Reload the extension and allow access ' +
      'to websites.'
    );
  }
  return `Could not take a screenshot: ${message}`;
}

/**
 * Thrown when the tab we were asked to photograph is not the one on screen.
 *
 * Its own type because the caller must treat it as "no frame this turn" rather than as
 * a failure: working from the page structure alone is a perfectly good turn, whereas
 * redacting the wrong image is not.
 */
export class WrongTabVisibleError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'WrongTabVisibleError';
  }
}

/**
 * Resolve the window, and refuse if the target tab is not the visible one in it.
 *
 * `captureVisibleTab` is addressed by *window*, not by tab — it photographs whatever is
 * currently visible there and ignores any tab id you have in mind. That is easy to miss
 * and produces the worst possible failure: switch tabs mid-task and we capture a
 * different page, then paint redaction boxes onto it using the element coordinates of
 * the page the agent is actually working on. Every mask lands somewhere meaningless
 * while the result still looks like a confident, redacted screenshot.
 *
 * So the tab's own `active` flag is checked first. Skipping the image is cheap; getting
 * it wrong is the one mistake this whole pipeline exists to prevent.
 */
async function visibleWindowFor(tabId: number): Promise<number> {
  let tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    throw new CaptureBlockedError('That tab is gone, so there is nothing to photograph.');
  }

  if (tab.active !== true) {
    throw new WrongTabVisibleError(
      'the tab the agent is working on is not the one on screen, so no picture was taken',
    );
  }
  if (tab.windowId === undefined) {
    throw new CaptureBlockedError('Could not work out which window to photograph.');
  }

  // A window that is not focused still has a visible tab, and capturing it is correct —
  // the user may be looking at the side panel in another window. What matters is that
  // the *target tab* is the active one in *its own* window, which is now established.
  return tab.windowId;
}

/**
 * Take one frame of the tab's visible viewport.
 *
 * JPEG rather than PNG: a PNG of a text-heavy page runs to several megabytes, and
 * payload size feeds straight into the latency score.
 */
export async function captureTab(
  tabId: number,
  options: CaptureOptions = {},
): Promise<CapturedFrame> {
  const format: ImageFormat = options.format ?? 'jpeg';
  const quality = options.quality ?? DEFAULT_QUALITY;
  const windowId = await visibleWindowFor(tabId);

  let dataUrl: string | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt <= THROTTLE_RETRIES; attempt++) {
    try {
      dataUrl = await browser.tabs.captureVisibleTab(windowId, {
        format: format === 'png' ? 'png' : 'jpeg',
        // Chrome ignores `quality` for PNG, which is correct and needs no guard.
        quality,
      });
      break;
    } catch (error) {
      lastError = error;
      if (!isThrottled(error) || attempt === THROTTLE_RETRIES) break;
      // Linear backoff past the one-second window rather than exponential: the limit
      // is a fixed rate, so waiting longer than the window is all that is needed.
      await sleep(THROTTLE_BACKOFF_MS * (attempt + 1));
    }
  }

  if (dataUrl === undefined || dataUrl === '') {
    throw new CaptureBlockedError(explain(lastError));
  }

  const { width, height } = await measure(dataUrl);

  // Measured, not `devicePixelRatio`. The two agree for this API, but the redaction
  // geometry depends on it and a silent mismatch would put every mask in the wrong
  // place while still producing a confident-looking image.
  const viewportWidth = options.viewport?.width ?? 0;
  const scale = viewportWidth > 0 ? width / viewportWidth : 1;

  return {
    dataUrl,
    width,
    height,
    scale,
    format,
    capturedAt: Date.now(),
  };
}

/**
 * Read the pixel dimensions of an encoded frame.
 *
 * `createImageBitmap` over a blob rather than an `<img>`: it does not need the
 * element attached to the document and it reports decode failures as a rejection
 * instead of an event nobody is listening for.
 */
async function measure(dataUrl: string): Promise<{ width: number; height: number }> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();
  return { width, height };
}

export function createCaptureAdapter(id: string): CaptureAdapter {
  return {
    id,
    captureViewport(tabId: number, options?: CaptureOptions): Promise<CapturedFrame> {
      return captureTab(tabId, options ?? {});
    },
    // Always ready. There is no session to establish and no surface to choose, which
    // is the entire point of moving to this API.
    isReady(): boolean {
      return true;
    },
  };
}

export function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const base64 = dataUrl.length - comma - 1;
  // base64 encodes 3 bytes per 4 characters.
  return Math.floor((base64 * 3) / 4);
}
