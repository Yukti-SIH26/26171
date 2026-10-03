/**
 * Transformers.js environment setup.
 *
 * The important property of this file is what it *forbids*. Remote models are
 * disabled outright, so there is no code path — not a fallback, not a retry, not
 * a cache miss — on which a model file is fetched from the internet. Weights are
 * bundled inside the extension by `npm run assets` and read over
 * `chrome-extension://`, which means:
 *
 *   - Inference is local, and so is model loading. "Offline" is unconditional.
 *   - No third party learns that this extension is installed, or which model it
 *     loads. In a privacy tool that matters more than the convenience of a CDN.
 *   - A missing file fails loudly at load time instead of silently reaching out.
 *
 * The weights are split into ONNX external-data chunks to stay under GitHub's
 * 100 MiB per-file limit. That is a packaging detail, not a model change: the
 * tensors are bit-identical to the single-file original.
 */

import { env } from '@huggingface/transformers';
import type { BrowserCapabilities } from '@sih/core';

// Let the bundler emit ONNX Runtime's own wasm and its loader as assets, and hand
// us their final URLs. Two reasons this is better than copying them into the
// public directory by hand:
//
//  - The build fails if they are missing, instead of the extension shipping and
//    then failing the first time a model is loaded.
//  - onnxruntime-web already causes the bundler to emit the wasm for its internal
//    `new URL(..., import.meta.url)` reference. Copying it separately would ship
//    26 MiB twice.
// The plain CPU build, not `.asyncify` and not `.jsep`.
//
// This line is why the pixel channel never ran. The asyncify build ships a reduced
// kernel set: it has no `Cast(13)` implementation, and OWL-ViT's classification head
// contains exactly that node, so session creation failed on every machine with
//
//   Could not find an implementation for Cast(13) node with name '/class_head/Cast'
//
// surfacing in the browser as an unassigned-provider error from graph partitioning.
//
// `.jsep` also works and carries the WebGPU glue, at 27 MiB and roughly twice the load
// time. It is the one to switch to if WebGPU execution is ever wanted; the plain build
// is 13.6 MiB and loads in about four seconds, which is the better trade while the
// detector runs on the CPU backend.
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';

export type Device = 'webgpu' | 'wasm';

let configured = false;

export interface EnvConfig {
  readonly device: Device;
  readonly threads: number;
  /** Root the model files are read from. Always an extension-local URL. */
  readonly modelRoot: string;
  /** True only when no network path to a model exists. */
  readonly offlineOnly: boolean;
}

/**
 * Resolve an extension-relative path to an absolute extension URL.
 *
 * Written against the callable shape rather than importing a browser polyfill so
 * this module stays testable in Node, where no extension APIs exist.
 */
function extensionUrl(path: string): string {
  const globals = globalThis as {
    chrome?: { runtime?: { getURL?: (p: string) => string } };
    browser?: { runtime?: { getURL?: (p: string) => string } };
  };
  const getURL = globals.chrome?.runtime?.getURL ?? globals.browser?.runtime?.getURL;
  if (typeof getURL !== 'function') {
    // Outside an extension context (tests, tooling). A relative path is the
    // honest answer; nothing will try to load weights here.
    return path;
  }
  return getURL(path);
}

/**
 * Make a bundler-emitted asset path absolute.
 *
 * `?url` yields a root-relative path such as `/assets/ort-….wasm`. ONNX Runtime
 * passes these to `fetch` and to a dynamic import, both of which resolve against
 * the current document — correct in the side panel, but fragile if this ever runs
 * somewhere with a different base. Resolving once here removes the ambiguity.
 */
function absolute(assetPath: string): string {
  try {
    return new URL(assetPath, globalThis.location?.href ?? 'chrome-extension://invalid/').href;
  } catch {
    return assetPath;
  }
}

/**
 * Configure the runtime once per context.
 *
 * WASM thread count is capped well below core count on purpose: saturating every
 * core makes the browser UI stutter, and a janky browser reads as a broken
 * extension regardless of how fast inference was.
 */
export function configureEnv(capabilities: BrowserCapabilities): EnvConfig {
  // Reported for the UI, not acted on blindly: the detector loader runs on the CPU
  // backend because the pinned binary is the CPU build and because a WebGPU-only
  // provider list cannot cover this graph. Probing WebGPU still tells the user
  // something true about their machine.
  const device: Device = capabilities.webgpu.available ? 'webgpu' : 'wasm';
  const modelRoot = extensionUrl('models');

  if (!configured) {
    env.allowLocalModels = true;
    env.localModelPath = modelRoot;

    // The single most important line here. No remote host is ever contacted.
    env.allowRemoteModels = false;

    // Pointless when the files are already local, and it would duplicate ~180
    // MiB into Cache Storage. Resident footprint is directly scored.
    env.useBrowserCache = false;

    // Must stay off under MV3. When enabled, transformers.js pre-fetches the ORT
    // loader and hands ONNX Runtime a `blob:` URL to import as a module — and
    // `script-src 'self'` forbids executing script from a blob. Disabling it makes
    // ORT import the loader directly from its extension URL, which is allowed.
    env.useWasmCache = false;

    // `env.backends.onnx.wasm` is typed readonly-optional, so it cannot be
    // created here — only populated. It is always present once onnxruntime-web
    // has been imported. If it somehow is not, we must not continue: leaving
    // `wasmPaths` unset is precisely the condition under which transformers.js
    // substitutes a jsDelivr URL, so a silent skip would quietly turn the
    // offline guarantee into a network fetch.
    const wasm = env.backends.onnx.wasm;
    if (wasm === undefined) {
      throw new Error(
        'onnxruntime wasm backend is unavailable, so its local file paths cannot be ' +
          'pinned. Refusing to continue: without pinning, model loading would fall ' +
          'back to a remote CDN.',
      );
    }

    // ONNX Runtime's own wasm binaries, resolved to bundled extension assets.
    //
    // Must be the `{ mjs, wasm }` object form; a bare prefix string takes a
    // different path inside transformers.js.
    wasm.wasmPaths = {
      mjs: absolute(ortMjsUrl),
      wasm: absolute(ortWasmUrl),
    };

    // Threads need SharedArrayBuffer, which needs cross-origin isolation that
    // extension pages do not have. Forcing 1 avoids a noisy failed attempt.
    wasm.numThreads = capabilities.wasm.threads
      ? Math.max(1, Math.min(4, capabilities.device.cores - 1))
      : 1;
    wasm.simd = capabilities.wasm.simd;

    configured = true;
  }

  return {
    device,
    threads: env.backends.onnx.wasm?.numThreads ?? 1,
    modelRoot,
    offlineOnly: !env.allowRemoteModels,
  };
}

/**
 * Quantization to request.
 *
 * Fixed at q8 (int8) because that is the variant bundled in the extension — there
 * is no other file to fall back to. It replaced q4, whose graph ONNX Runtime Web
 * cannot partition at all: session creation fails on both providers because the
 * classification head's `Cast` node is left without one.
 */
export function bundledDtype(): 'q8' {
  return 'q8';
}

/**
 * Number of external-data chunks the bundled weights are split across.
 *
 * Must match what `scripts/split_onnx.py` produced. transformers.js derives the
 * filenames from this count: `model_q4.onnx_data`, `model_q4.onnx_data_1`, …
 */
export const EXTERNAL_DATA_CHUNKS = 2;

export function isEnvConfigured(): boolean {
  return configured;
}

/** Test seam: forget that configuration happened. */
export function resetEnvForTesting(): void {
  configured = false;
}
