/**
 * The dispatch adapter, shared verbatim by Chrome and Firefox.
 *
 * Every action is relayed to the content script, which performs it with synthetic
 * DOM events. Chrome could produce genuinely trusted input through
 * `chrome.debugger`, and that is worth having later — but Firefox has no
 * equivalent, so the portable path has to be the real one rather than a fallback.
 * Building on CDP would fork the executor into two incompatible versions and leave
 * Firefox permanently second-class.
 *
 * The honest limitation, stated rather than hidden: `isTrusted` is false on these
 * events. Most sites cannot tell and do not care. A minority of hardened login
 * flows check it and will ignore the input. `trusted: false` is reported on the
 * adapter so the UI can say so instead of leaving the user to guess why a click
 * did nothing.
 */

import type { DispatchAdapter, DispatchKind, ElementId, Point } from '@sih/core';
import { browser } from 'wxt/browser';
import {
  MSG,
  isActedResponse,
  isErrorResponse,
  type ActRequest,
} from '../messaging/protocol.ts';

/**
 * Thrown when an action reached the page but the page refused it.
 *
 * Distinct from a messaging failure: this means the executor worked and the answer
 * was no, which the agent loop should treat as feedback rather than a crash.
 */
export class ActionFailedError extends Error {
  readonly op: string;
  readonly obscured: boolean;

  constructor(op: string, detail: string, obscured = false) {
    super(detail);
    this.name = 'ActionFailedError';
    this.op = op;
    this.obscured = obscured;
  }
}

export interface ActOutcome {
  readonly ok: boolean;
  readonly detail: string;
  readonly durationMs: number;
  readonly obscured: boolean;
}

/**
 * Send one action and interpret the reply.
 *
 * Throws on refusal rather than returning a flag, because a caller that ignores a
 * failed click will go on to act as though the page changed when it did not — and
 * that compounds into the agent operating on a stale mental model.
 */
async function send(tabId: number, request: ActRequest): Promise<ActOutcome> {
  let response: unknown;
  try {
    response = await browser.tabs.sendMessage(tabId, request);
  } catch (error) {
    throw new ActionFailedError(
      request.op,
      `could not reach the page: ${error instanceof Error ? error.message : 'no receiving end'}`,
    );
  }

  if (isErrorResponse(response)) {
    throw new ActionFailedError(request.op, response.message);
  }
  if (!isActedResponse(response)) {
    throw new ActionFailedError(request.op, 'unexpected response shape from the page');
  }
  if (!response.ok) {
    throw new ActionFailedError(request.op, response.detail, response.obscured === true);
  }

  return {
    ok: true,
    detail: response.detail,
    durationMs: response.durationMs,
    obscured: response.obscured === true,
  };
}

/**
 * Track the last outcome so the UI can show what actually happened.
 *
 * Deliberately holds only the description the content script produced, which
 * reports value *lengths* rather than values.
 */
let lastOutcome: ActOutcome | undefined;

export function lastActionOutcome(): ActOutcome | undefined {
  return lastOutcome;
}

async function run(tabId: number, request: ActRequest): Promise<void> {
  lastOutcome = await send(tabId, request);
}

export function createContentScriptDispatch(id: string, kind: DispatchKind): DispatchAdapter {
  return {
    id,
    kind,
    // Synthetic events carry `isTrusted: false`. Saying so here lets the rest of
    // the system reason about it instead of discovering it on a hardened site.
    trusted: false,

    click(tabId: number, target: ElementId): Promise<void> {
      return run(tabId, { type: MSG.act, op: 'click', target });
    },

    clickPoint(tabId: number, point: Point): Promise<void> {
      return run(tabId, { type: MSG.act, op: 'clickPoint', point });
    },

    typeText(
      tabId: number,
      target: ElementId,
      text: string,
      options?: { readonly clear?: boolean; readonly submit?: boolean },
    ): Promise<void> {
      return run(tabId, {
        type: MSG.act,
        op: 'type',
        target,
        text,
        ...(options?.clear === undefined ? {} : { clear: options.clear }),
        ...(options?.submit === undefined ? {} : { submit: options.submit }),
      });
    },

    hover(tabId: number, target: ElementId): Promise<void> {
      return run(tabId, { type: MSG.act, op: 'hover', target });
    },

    selectOption(tabId: number, target: ElementId, value: string): Promise<void> {
      return run(tabId, { type: MSG.act, op: 'select', target, text: value });
    },

    scroll(tabId: number, deltaX: number, deltaY: number, target?: ElementId): Promise<void> {
      return run(tabId, {
        type: MSG.act,
        op: 'scroll',
        deltaX,
        deltaY,
        ...(target === undefined ? {} : { target }),
      });
    },

    pressKeys(tabId: number, keys: string): Promise<void> {
      return run(tabId, { type: MSG.act, op: 'keyPress', keys });
    },

    /**
     * Nothing to release: the content script holds no per-action state, and the
     * element registry is tied to the document's own lifetime.
     *
     * Implemented rather than thrown so the caller can always call it, which keeps
     * teardown paths uniform across adapters that do need cleanup.
     */
    detach(_tabId: number): Promise<void> {
      lastOutcome = undefined;
      return Promise.resolve();
    },
  };
}
