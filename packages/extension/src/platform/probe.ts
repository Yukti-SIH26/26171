/**
 * Runtime capability probe.
 *
 * Must run in a context with a real DOM (side panel, offscreen document,
 * extension page). A service worker has no `navigator.gpu`, so probing there
 * would wrongly report WebGPU as unavailable.
 *
 * Everything here is feature detection, never user-agent sniffing, with one
 * exception: which *browser* we are is taken from the build-time constant WXT
 * injects, because the two builds genuinely differ and we want that decided at
 * compile time rather than guessed at runtime.
 */

import { browser } from 'wxt/browser';
import type {
  BrowserCapabilities,
  BrowserKind,
  DeviceReport,
  ExtensionApiReport,
  SidePanelApi,
  WasmReport,
  WebGpuReport,
} from '@sih/core';
import { navigatorWithGpu } from './webgpu-types.ts';

function detectBrowser(): BrowserKind {
  const b = import.meta.env.BROWSER;
  if (b === 'chrome' || b === 'edge' || b === 'opera' || b === 'chromium') return 'chrome';
  if (b === 'firefox') return 'firefox';
  return 'unknown';
}

/**
 * Best-effort WASM SIMD detection.
 *
 * Validates a tiny module that uses a v128 instruction. A false negative is
 * safe (we assume the slower path); a false positive is not possible, since an
 * engine without SIMD rejects the module.
 */
function detectWasmSimd(): boolean {
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function') {
    return false;
  }
  try {
    // (module (func (result v128) i32.const 0 i8x16.splat))
    const bytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00, 0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62,
      0x0b,
    ]);
    return WebAssembly.validate(bytes);
  } catch {
    return false;
  }
}

function probeWasm(): WasmReport {
  const sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
  // Threaded WASM needs SharedArrayBuffer, which needs cross-origin isolation.
  // Extension pages are not isolated by default, so this is usually false and
  // heavy WASM runs single-threaded.
  const isolated = typeof self !== 'undefined' && self.crossOriginIsolated === true;
  return {
    simd: detectWasmSimd(),
    threads: sharedArrayBuffer && isolated,
    sharedArrayBuffer,
  };
}

/**
 * Probe WebGPU, reading real adapter limits.
 *
 * Limits are read rather than assumed because they are driver-dependent: the
 * spec default `maxBufferSize` is 256 MiB, desktop discrete GPUs report far
 * more, and mobile often stays at the default. A model that loads on one
 * machine can fail to allocate on another, so the limits decide what we load.
 */
async function probeWebGpu(): Promise<WebGpuReport> {
  const nav = navigatorWithGpu();
  if (nav.gpu === undefined) {
    return { available: false, reason: 'navigator.gpu is not present in this context' };
  }
  try {
    // No `powerPreference`: Chrome ignores it on Windows (crbug.com/369219127)
    // and passing it only produces console noise.
    const adapter = await nav.gpu.requestAdapter();
    if (adapter === null) {
      return { available: false, reason: 'no GPU adapter available (driver or blocklist)' };
    }

    // `adapter.info` is the current API; `requestAdapterInfo()` was the earlier
    // spelling. Try both so the probe works across browser versions.
    let info = adapter.info;
    if (info === undefined && typeof adapter.requestAdapterInfo === 'function') {
      try {
        info = await adapter.requestAdapterInfo();
      } catch {
        info = undefined;
      }
    }

    const limits = adapter.limits;
    const report: WebGpuReport = {
      available: true,
      ...(info === undefined
        ? {}
        : {
            adapter: {
              vendor: info.vendor ?? 'unknown',
              architecture: info.architecture ?? 'unknown',
              device: info.device ?? 'unknown',
              description: info.description ?? 'unknown',
            },
          }),
      ...(limits === undefined
        ? {}
        : {
            limits: {
              maxBufferSize: limits.maxBufferSize ?? 0,
              maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize ?? 0,
              maxComputeWorkgroupStorageSize: limits.maxComputeWorkgroupStorageSize ?? 0,
              maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup ?? 0,
            },
          }),
    };
    return report;
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : 'requestAdapter threw',
    };
  }
}

function detectSidePanelApi(kind: BrowserKind): SidePanelApi {
  const api = browser as unknown as Record<string, unknown>;
  if (api['sidePanel'] !== undefined) return 'side_panel';
  if (api['sidebarAction'] !== undefined) return 'sidebar_action';
  // Firefox exposes sidebarAction only when the manifest declares it; fall back
  // to the known platform default rather than reporting nothing.
  return kind === 'firefox' ? 'sidebar_action' : 'none';
}

function probeApis(kind: BrowserKind): ExtensionApiReport {
  const api = browser as unknown as Record<string, unknown>;
  const tabs = api['tabs'] as { captureVisibleTab?: unknown } | undefined;
  return {
    offscreen: api['offscreen'] !== undefined,
    debugger: api['debugger'] !== undefined,
    scripting: api['scripting'] !== undefined,
    sidePanel: detectSidePanelApi(kind),
    tabsCapture: typeof tabs?.captureVisibleTab === 'function',
  };
}

function probeDevice(): DeviceReport {
  const nav = navigatorWithGpu();
  return {
    memoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : 1,
    platform: typeof nav.platform === 'string' ? nav.platform : 'unknown',
  };
}

function extensionVersion(): string {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return '0.0.0';
  }
}

export async function probeCapabilities(): Promise<BrowserCapabilities> {
  const kind = detectBrowser();
  const webgpu = await probeWebGpu();
  return {
    browser: kind,
    manifestVersion: import.meta.env.MANIFEST_VERSION,
    extensionVersion: extensionVersion(),
    webgpu,
    wasm: probeWasm(),
    apis: probeApis(kind),
    device: probeDevice(),
    probedAt: Date.now(),
  };
}
