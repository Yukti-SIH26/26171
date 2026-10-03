/**
 * Model host.
 *
 * Local inference needs a context with a DOM, WebGPU access, and a lifetime
 * longer than a single message. Three candidates exist and only one works on both
 * browsers today:
 *
 *   Chrome offscreen document  no Firefox equivalent (`chrome.offscreen` absent)
 *   Firefox background page    Chrome's MV3 background is a worker with no DOM
 *   Side panel page            exists on both, full DOM, WebGPU available
 *
 * So v1 runs models in the side panel context. That is not a compromise for the
 * usage pattern: the agent runs when the user is driving it from the panel, and
 * the panel is open exactly then. Closing the panel releasing the models is
 * desirable on a 4 GB machine rather than a bug.
 *
 * Kept behind this interface so background operation can move to an offscreen
 * document on Chrome later without touching any calling code.
 */

import type { BrowserCapabilities, ModelHostAdapter, ModelHostKind } from '@sih/core';
import { configureEnv } from '../models/env.ts';
import { disposeDetector, isDetectorLoaded } from '../models/vision.ts';
import { disposeOcrWorker, isOcrReady } from '../models/ocr.ts';

export interface ModelHostState {
  readonly ready: boolean;
  readonly detectorLoaded: boolean;
  readonly ocrLoaded: boolean;
  readonly device: string;
  readonly threads: number;
}

export function createSidePanelModelHost(
  id: string,
  kind: ModelHostKind,
  capabilities: BrowserCapabilities,
): ModelHostAdapter {
  let prepared = false;

  return {
    id,
    kind,

    ensureReady(): Promise<void> {
      if (!prepared) {
        configureEnv(capabilities);
        prepared = true;
      }
      return Promise.resolve();
    },

    isReady(): Promise<boolean> {
      return Promise.resolve(prepared);
    },

    /**
     * Release everything. Called when the user closes the panel or switches
     * models, since resident memory is directly scored.
     */
    async dispose(): Promise<void> {
      await Promise.all([disposeDetector(), disposeOcrWorker()]);
      prepared = false;
    },
  };
}

export function modelHostState(capabilities: BrowserCapabilities): ModelHostState {
  const config = configureEnv(capabilities);
  return {
    ready: true,
    detectorLoaded: isDetectorLoaded(),
    ocrLoaded: isOcrReady(),
    device: config.device,
    threads: config.threads,
  };
}
