/**
 * Typed message protocol between side panel, background, and content script.
 *
 * Extension messaging is `any`-shaped by nature, which is a poor fit for a
 * codebase where one wrong payload could move a secret into the wrong context.
 * Every message is therefore a discriminated union with an explicit runtime
 * guard, so an unexpected shape is rejected at the boundary rather than
 * propagating as `undefined` three layers in.
 */

import type { ElementGraph } from '@sih/core';

export const MSG = {
  ping: 'kavach:ping',
  pong: 'kavach:pong',
  observe: 'kavach:observe',
  observed: 'kavach:observed',
  showOverlay: 'kavach:overlay:show',
  hideOverlay: 'kavach:overlay:hide',
  overlayState: 'kavach:overlay:state',
  act: 'kavach:act',
  acted: 'kavach:acted',
  settle: 'kavach:settle',
  settled: 'kavach:settled',
  error: 'kavach:error',
} as const;

export interface PingRequest {
  readonly type: typeof MSG.ping;
}

export interface PongResponse {
  readonly type: typeof MSG.pong;
  readonly url: string;
  readonly title: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly devicePixelRatio: number;
  readonly respondedAt: number;
}

export interface ObserveRequest {
  readonly type: typeof MSG.observe;
  readonly maxNodes?: number;
  readonly includeHidden?: boolean;
  readonly includeStructural?: boolean;
  /** Draw the debug overlay on the page as part of the same pass. */
  readonly drawOverlay?: boolean;
}

export interface ObserveMetrics {
  readonly durationMs: number;
  readonly elementsVisited: number;
  readonly nodesEmitted: number;
  readonly interactiveCount: number;
  readonly editableCount: number;
  readonly passwordFieldCount: number;
  readonly hiddenCount: number;
  readonly registrySize: number;
  readonly overlayBoxes: number;
}

export interface ObservedResponse {
  readonly type: typeof MSG.observed;
  readonly graph: ElementGraph;
  readonly metrics: ObserveMetrics;
}

export interface ShowOverlayRequest {
  readonly type: typeof MSG.showOverlay;
  readonly includeStructural?: boolean;
}

export interface HideOverlayRequest {
  readonly type: typeof MSG.hideOverlay;
}

export interface OverlayStateResponse {
  readonly type: typeof MSG.overlayState;
  readonly visible: boolean;
  readonly boxes: number;
}

export interface ErrorResponse {
  readonly type: typeof MSG.error;
  readonly message: string;
  readonly operation: string;
}

/**
 * Perform one action in the page.
 *
 * Note what crosses this boundary: a resolved literal `text`, never a placeholder.
 * Resolution happens in the panel, against the unlocked vault, immediately before
 * dispatch — so the plaintext exists in the content script for the duration of one
 * message and is not retained anywhere.
 */
export interface ActRequest {
  readonly type: typeof MSG.act;
  readonly op: 'click' | 'clickPoint' | 'type' | 'hover' | 'select' | 'scroll' | 'keyPress';
  readonly target?: string;
  readonly point?: { readonly x: number; readonly y: number };
  /** Already-resolved value. Cleared by the content script after use. */
  readonly text?: string;
  readonly clear?: boolean;
  readonly submit?: boolean;
  readonly keys?: string;
  readonly deltaX?: number;
  readonly deltaY?: number;
}

export interface ActedResponse {
  readonly type: typeof MSG.acted;
  readonly op: string;
  readonly ok: boolean;
  /** What the page looked like at the target afterwards, for the audit trail. */
  readonly detail: string;
  readonly durationMs: number;
  /** True when the element under the target point was not the target itself. */
  readonly obscured?: boolean;
}

/**
 * Tell me when the page stops changing.
 *
 * Replaces a fixed sleep on the caller's side. A sleep has to be long enough for the
 * slowest page, so it is wrong for every other page: 700 ms after every click, 900 ms
 * after every submit, spent doing nothing on a page that had already finished in 40 ms.
 * The page itself knows when it has settled, so it is asked.
 */
export interface SettleRequest {
  readonly type: typeof MSG.settle;
  /** How long the DOM must be still before it counts as settled. */
  readonly quietMs: number;
  /** Give up waiting after this and report what we have. */
  readonly timeoutMs: number;
}

export interface SettledResponse {
  readonly type: typeof MSG.settled;
  /** True when quiet was reached; false when the timeout ran out first. */
  readonly quiet: boolean;
  readonly waitedMs: number;
  readonly mutations: number;
}

export type ContentRequest =
  | PingRequest
  | ObserveRequest
  | ShowOverlayRequest
  | HideOverlayRequest
  | ActRequest
  | SettleRequest;

export type ContentResponse =
  | PongResponse
  | ObservedResponse
  | OverlayStateResponse
  | ActedResponse
  | SettledResponse
  | ErrorResponse;

function hasType(message: unknown): message is { type: string } {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { type?: unknown }).type === 'string'
  );
}

export function isContentRequest(message: unknown): message is ContentRequest {
  if (!hasType(message)) return false;
  return (
    message.type === MSG.ping ||
    message.type === MSG.observe ||
    message.type === MSG.showOverlay ||
    message.type === MSG.hideOverlay ||
    message.type === MSG.act ||
    message.type === MSG.settle
  );
}

export function isActedResponse(message: unknown): message is ActedResponse {
  return hasType(message) && message.type === MSG.acted;
}

export function isSettledResponse(message: unknown): message is SettledResponse {
  return hasType(message) && message.type === MSG.settled;
}

export function isObservedResponse(message: unknown): message is ObservedResponse {
  return hasType(message) && message.type === MSG.observed;
}

export function isPongResponse(message: unknown): message is PongResponse {
  return hasType(message) && message.type === MSG.pong;
}

export function isOverlayState(message: unknown): message is OverlayStateResponse {
  return hasType(message) && message.type === MSG.overlayState;
}

export function isErrorResponse(message: unknown): message is ErrorResponse {
  return hasType(message) && message.type === MSG.error;
}

export function errorResponse(operation: string, error: unknown): ErrorResponse {
  return {
    type: MSG.error,
    operation,
    message: error instanceof Error ? error.message : String(error),
  };
}
