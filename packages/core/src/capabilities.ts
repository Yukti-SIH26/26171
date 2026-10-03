/**
 * Runtime capability report.
 *
 * Probed once at startup and consulted for every subsequent decision about how
 * to run. This exists because the two target browsers genuinely differ in ways
 * that change the architecture, not just the config:
 *
 *   Chrome                          Firefox
 *   ------                          -------
 *   chrome.debugger (CDP)           absent  -> synthetic events only
 *   chrome.offscreen documents      absent  -> model host is an extension page
 *   side_panel API                  sidebar_action API
 *
 * WebGPU also varies by machine and driver, not just by browser, so the
 * adapter limits have to be read at runtime rather than assumed. A model that
 * loads on one laptop will fail on another with a smaller `maxBufferSize`.
 */

export type BrowserKind = 'chrome' | 'firefox' | 'unknown';

export type SidePanelApi = 'side_panel' | 'sidebar_action' | 'none';

export type ModelBackend = 'webgpu' | 'wasm';

export interface WebGpuAdapterInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
}

export interface WebGpuLimits {
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxComputeWorkgroupStorageSize: number;
  readonly maxComputeInvocationsPerWorkgroup: number;
}

export interface WebGpuReport {
  readonly available: boolean;
  /** Why it is unavailable, when it is. */
  readonly reason?: string;
  readonly adapter?: WebGpuAdapterInfo;
  readonly limits?: WebGpuLimits;
}

export interface WasmReport {
  readonly simd: boolean;
  /** Threads need SharedArrayBuffer, which needs COOP/COEP headers. */
  readonly threads: boolean;
  readonly sharedArrayBuffer: boolean;
}

export interface ExtensionApiReport {
  /** `chrome.offscreen`. Chrome-only. Where heavy models run. */
  readonly offscreen: boolean;
  /** `chrome.debugger`. Chrome-only. The only route to trusted input events. */
  readonly debugger: boolean;
  readonly scripting: boolean;
  readonly sidePanel: SidePanelApi;
  readonly tabsCapture: boolean;
}

export interface DeviceReport {
  /** `navigator.deviceMemory`, in GB. Coarse and often absent. */
  readonly memoryGb: number | null;
  readonly cores: number;
  readonly platform: string;
}

export interface BrowserCapabilities {
  readonly browser: BrowserKind;
  readonly manifestVersion: 2 | 3;
  readonly extensionVersion: string;
  readonly webgpu: WebGpuReport;
  readonly wasm: WasmReport;
  readonly apis: ExtensionApiReport;
  readonly device: DeviceReport;
  readonly probedAt: number;
}

/**
 * Pick the inference backend.
 *
 * WebGPU is the fast path and the one the problem statement calls for, but it
 * must never be load-bearing: Firefox on Linux and older Safari lack it, and
 * some drivers advertise it then fail under load.
 */
export function chooseBackend(caps: BrowserCapabilities): ModelBackend {
  return caps.webgpu.available ? 'webgpu' : 'wasm';
}

/**
 * Can the browser dispatch input events indistinguishable from a human's?
 *
 * Matters because hardened sites legitimately ignore `isTrusted: false` events.
 * Chrome can, via CDP. Firefox cannot, so some real-site flows will behave
 * differently there and we need to report that honestly rather than hide it.
 */
export function canDispatchTrustedEvents(caps: BrowserCapabilities): boolean {
  return caps.apis.debugger;
}

/** Rough sanity check: can this machine run the local pipeline at all? */
export function meetsMinimumRequirements(caps: BrowserCapabilities): boolean {
  const hasBackend = caps.webgpu.available || caps.wasm.simd;
  return hasBackend && caps.apis.tabsCapture && caps.apis.scripting;
}

export function summarize(caps: BrowserCapabilities): string {
  const backend = chooseBackend(caps);
  const trusted = canDispatchTrustedEvents(caps) ? 'trusted' : 'synthetic';
  return `${caps.browser} MV${caps.manifestVersion} · ${backend} · ${trusted} input`;
}
