/**
 * The observe adapter, shared verbatim by Chrome and Firefox.
 *
 * Chrome could read an accessibility tree through CDP instead, and it would be
 * less code. It is not used, because Firefox has no equivalent and the
 * perception layer would then exist in two incompatible versions. One extractor,
 * running in a content script, on both platforms.
 */

import type { ElementGraph, ObserveAdapter, ObserveOptions } from '@sih/core';
import { browser } from 'wxt/browser';
import {
  MSG,
  isErrorResponse,
  isObservedResponse,
  type ObserveMetrics,
  type ObserveRequest,
} from '../messaging/protocol.ts';
import { ensureContentScript } from './inject.ts';

export interface ObserveResult {
  readonly graph: ElementGraph;
  readonly metrics: ObserveMetrics;
}

export class ContentScriptUnreachableError extends Error {
  constructor(cause: string) {
    super(
      `the page reader could not be reached: ${cause}. ` +
        'Browser-internal pages, the add-on store, and PDF viewers block extension scripts.',
    );
    this.name = 'ContentScriptUnreachableError';
  }
}

/** Observe with metrics, which the diagnostics UI needs and the interface omits. */
export async function observeWithMetrics(
  tabId: number,
  options: ObserveOptions & {
    readonly drawOverlay?: boolean;
    readonly includeStructural?: boolean;
  },
): Promise<ObserveResult> {
  const request: ObserveRequest = {
    type: MSG.observe,
    ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
    ...(options.includeStructural === undefined
      ? {}
      : { includeStructural: options.includeStructural }),
    ...(options.drawOverlay === undefined ? {} : { drawOverlay: options.drawOverlay }),
  };

  // Before talking to the page, make sure there is something in it to talk to. A
  // declared content script is absent from every tab that was already open, so without
  // this the first observation on the user's current tab always failed.
  await ensureContentScript(tabId);

  let response: unknown;
  try {
    response = await browser.tabs.sendMessage(tabId, request);
  } catch (error) {
    throw new ContentScriptUnreachableError(
      error instanceof Error ? error.message : 'no receiving end',
    );
  }

  if (isErrorResponse(response)) {
    throw new Error(`page reader failed during ${response.operation}: ${response.message}`);
  }
  if (!isObservedResponse(response)) {
    throw new ContentScriptUnreachableError('unexpected response shape');
  }
  return { graph: response.graph, metrics: response.metrics };
}

export function createContentScriptObserve(id: string): ObserveAdapter {
  return {
    id,
    async observe(tabId: number, options?: ObserveOptions): Promise<ElementGraph> {
      const result = await observeWithMetrics(tabId, options ?? {});
      return result.graph;
    },
  };
}

export async function setOverlay(
  tabId: number,
  visible: boolean,
  includeStructural = false,
): Promise<number> {
  const request = visible
    ? { type: MSG.showOverlay, includeStructural }
    : { type: MSG.hideOverlay };

  await ensureContentScript(tabId);

  try {
    const response = await browser.tabs.sendMessage(tabId, request);
    if (isErrorResponse(response)) throw new Error(response.message);
    if (typeof response === 'object' && response !== null && 'boxes' in response) {
      return (response as { boxes: number }).boxes;
    }
    return 0;
  } catch (error) {
    throw new ContentScriptUnreachableError(
      error instanceof Error ? error.message : 'no receiving end',
    );
  }
}
