/**
 * Platform Abstraction Layer.
 *
 * Chrome and Firefox differ enough that a shared codebase needs real seams, not
 * `if (isFirefox)` scattered through the logic. Four capabilities are abstracted:
 *
 *   Capture    screenshot of the visible viewport
 *   Observe    structure channel (DOM walk) from a tab
 *   Dispatch   perform an action in a tab
 *   ModelHost  a long-lived context where local models can run off the UI thread
 *
 * The portable content-script path is primary for every one of these. CDP is an
 * optional Chrome accelerator and must never be load-bearing, because Firefox
 * has no equivalent. Getting that inversion right up front is cheaper than
 * discovering it after the perception layer is built on top of CDP.
 */

import type { Point } from './geometry.ts';
import type { ElementGraph, ElementId } from './element.ts';
import type { BrowserCapabilities, BrowserKind } from './capabilities.ts';

export type ImageFormat = 'png' | 'jpeg';

export interface CapturedFrame {
  /** `data:` URL. Stays local until the redactor has painted over it. */
  readonly dataUrl: string;
  /** Frame pixels, as captured. */
  readonly width: number;
  readonly height: number;
  /**
   * Multiply a CSS-pixel coordinate by this to reach frame pixels.
   *
   * **Measured, never assumed.** It is derived from the frame's own width against the
   * viewport width rather than read from `devicePixelRatio`. Redaction geometry
   * depends entirely on this number, and a silent mismatch puts every mask in the
   * wrong place while still producing a confident-looking image — worse than not
   * redacting, because it looks like it worked.
   */
  readonly scale: number;
  readonly format: ImageFormat;
  readonly capturedAt: number;
}

export interface CaptureOptions {
  readonly format?: ImageFormat;
  /** JPEG quality 0..100. Ignored for PNG. */
  readonly quality?: number;
  /**
   * The CSS-pixel viewport the frame should correspond to.
   *
   * Required to compute `scale` and to detect a mismatched capture surface. Without
   * it a stream-based adapter has nothing to calibrate against.
   */
  readonly viewport?: { readonly width: number; readonly height: number };
}

export interface CaptureAdapter {
  /** Stable identifier for diagnostics, e.g. `chrome:captureVisibleTab`. */
  readonly id: string;
  captureViewport(tabId: number, options?: CaptureOptions): Promise<CapturedFrame>;
  /** True when frames can be taken right now without further user interaction. */
  isReady?(): boolean;
}

export interface ObserveOptions {
  /** Walk into same-origin iframes. */
  readonly includeFrames?: boolean;
  /** Cap on returned nodes, to bound payload size and latency. */
  readonly maxNodes?: number;
}

export interface ObserveAdapter {
  readonly id: string;
  observe(tabId: number, options?: ObserveOptions): Promise<ElementGraph>;
}

/**
 * How input events are produced.
 *  - `cdp-trusted`: Chrome via `chrome.debugger`. `isTrusted: true`.
 *  - `synthetic`:   dispatched from a content script. `isTrusted: false`, which
 *                   hardened sites may legitimately ignore.
 */
export type DispatchKind = 'cdp-trusted' | 'synthetic';

export interface DispatchAdapter {
  readonly id: string;
  readonly kind: DispatchKind;
  /** True only when events are indistinguishable from real user input. */
  readonly trusted: boolean;

  click(tabId: number, target: ElementId): Promise<void>;
  clickPoint(tabId: number, point: Point): Promise<void>;
  typeText(
    tabId: number,
    target: ElementId,
    text: string,
    options?: { readonly clear?: boolean; readonly submit?: boolean },
  ): Promise<void>;
  hover(tabId: number, target: ElementId): Promise<void>;
  selectOption(tabId: number, target: ElementId, value: string): Promise<void>;
  scroll(tabId: number, deltaX: number, deltaY: number, target?: ElementId): Promise<void>;
  pressKeys(tabId: number, keys: string): Promise<void>;

  /** Release any attached debugger session or injected state. */
  detach(tabId: number): Promise<void>;
}

/**
 * Where local models live.
 *
 * Needs a DOM (for canvas and WebGPU) and a lifetime longer than a service
 * worker's, so it cannot be the MV3 background. Chrome uses an offscreen
 * document; Firefox has no such API and uses a hidden extension page.
 */
export type ModelHostKind = 'offscreen-document' | 'extension-page' | 'side-panel';

export interface ModelHostAdapter {
  readonly id: string;
  readonly kind: ModelHostKind;
  /** Create the host if absent. Idempotent. */
  ensureReady(): Promise<void>;
  isReady(): Promise<boolean>;
  /** Tear down to reclaim memory, which is scored. */
  dispose(): Promise<void>;
}

export interface PlatformAdapters {
  readonly browser: BrowserKind;
  readonly capabilities: BrowserCapabilities;
  readonly capture: CaptureAdapter;
  readonly observe: ObserveAdapter;
  readonly dispatch: DispatchAdapter;
  readonly modelHost: ModelHostAdapter;
}

/**
 * Thrown by adapter methods that are not wired up yet.
 *
 * A distinct error type so the side panel can distinguish "this browser cannot
 * do that" from "this is still a stub", which are very different problems.
 */
export class NotImplementedError extends Error {
  readonly adapterId: string;
  readonly operation: string;

  constructor(adapterId: string, operation: string) {
    super(`${adapterId}: ${operation} is not implemented yet`);
    this.name = 'NotImplementedError';
    this.adapterId = adapterId;
    this.operation = operation;
  }
}

/** Thrown when the current browser fundamentally lacks a capability. */
export class UnsupportedPlatformError extends Error {
  readonly browser: BrowserKind;
  readonly operation: string;

  constructor(browser: BrowserKind, operation: string, hint?: string) {
    super(
      `${operation} is not supported on ${browser}${hint === undefined ? '' : `: ${hint}`}`,
    );
    this.name = 'UnsupportedPlatformError';
    this.browser = browser;
    this.operation = operation;
  }
}
