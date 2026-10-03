import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { extractElementGraph } from '../perception/extract.ts';
import { ElementRegistry } from '../perception/registry.ts';
import { clearOverlay, drawOverlay, isOverlayVisible } from '../perception/overlay.ts';
import {
  performClick,
  performClickPoint,
  performHover,
  performKeyPress,
  performScroll,
  performSelect,
  performType,
} from '../perception/perform.ts';
import {
  MSG,
  errorResponse,
  isContentRequest,
  type ActRequest,
  type ActedResponse,
  type ContentRequest,
  type ContentResponse,
  type ObserveMetrics,
  type SettleRequest,
  type SettledResponse,
} from '../messaging/protocol.ts';

/**
 * Structure-channel content script.
 *
 * Runs in the page's isolated world: same DOM, separate JS context. Page script
 * cannot see these variables, and we do not touch page globals. This is the
 * portable path that exists identically on Chrome and Firefox, which is why the
 * perception layer is built on it rather than on CDP.
 *
 * The element registry lives for the lifetime of the document so IDs stay stable
 * across repeated observations. A real navigation loads a fresh content script
 * and therefore a fresh registry, which is the correct boundary.
 */

const registry = new ElementRegistry();
let lastOverlayBoxes = 0;

function summarize(
  graph: ReturnType<typeof extractElementGraph>['graph'],
  durationMs: number,
  elementsVisited: number,
  overlayBoxes: number,
): ObserveMetrics {
  let interactiveCount = 0;
  let editableCount = 0;
  let passwordFieldCount = 0;
  let hiddenCount = 0;

  for (const node of graph.nodes) {
    if (node.flags.interactive) interactiveCount++;
    if (node.flags.editable) editableCount++;
    if (node.inputType === 'password') passwordFieldCount++;
    if (node.flags.hidden) hiddenCount++;
  }

  return {
    durationMs,
    elementsVisited,
    nodesEmitted: graph.nodes.length,
    interactiveCount,
    editableCount,
    passwordFieldCount,
    hiddenCount,
    registrySize: registry.size,
    overlayBoxes,
  };
}

/**
 * Perform one action.
 *
 * Kept async and separate from `handle` because every real interaction needs to
 * wait on layout: scrolling a target into view, then letting a sticky header
 * settle, before the coordinates used for a hit test are meaningful.
 *
 * The overlay is cleared first. It is a debug decoration with `pointer-events:
 * none`, so it cannot intercept a click — but it does sit over the page while the
 * action runs, and leaving stale boxes on screen during an interaction makes the
 * audit screenshot misleading.
 */
async function act(request: ActRequest): Promise<ActedResponse> {
  const started = performance.now();
  const overlayWasVisible = isOverlayVisible(document);
  if (overlayWasVisible) clearOverlay(document);

  let result: { ok: boolean; detail: string; obscured?: boolean };

  switch (request.op) {
    case 'click':
      result =
        request.target === undefined
          ? { ok: false, detail: 'no target given' }
          : await performClick(registry, request.target);
      break;

    case 'clickPoint':
      result =
        request.point === undefined
          ? { ok: false, detail: 'no point given' }
          : performClickPoint(request.point);
      break;

    case 'type':
      result =
        request.target === undefined || request.text === undefined
          ? { ok: false, detail: 'target and text are both required' }
          : await performType(registry, request.target, request.text, {
              ...(request.clear === undefined ? {} : { clear: request.clear }),
              ...(request.submit === undefined ? {} : { submit: request.submit }),
            });
      break;

    case 'hover':
      result =
        request.target === undefined
          ? { ok: false, detail: 'no target given' }
          : await performHover(registry, request.target);
      break;

    case 'select':
      result =
        request.target === undefined || request.text === undefined
          ? { ok: false, detail: 'target and option are both required' }
          : await performSelect(registry, request.target, request.text);
      break;

    case 'scroll':
      result = performScroll(
        registry,
        request.deltaX ?? 0,
        request.deltaY ?? 0,
        request.target,
      );
      break;

    case 'keyPress':
      result =
        request.keys === undefined
          ? { ok: false, detail: 'no keys given' }
          : performKeyPress(request.keys);
      break;
  }

  return {
    type: MSG.acted,
    op: request.op,
    ok: result.ok,
    detail: result.detail,
    durationMs: performance.now() - started,
    ...(result.obscured === true ? { obscured: true } : {}),
  };
}

/**
 * Resolve once the page has stopped changing.
 *
 * The caller used to sleep a fixed 700–900 ms after every action. That number has to
 * cover the slowest page, which makes it wrong for all the others: most clicks are
 * finished re-rendering in a few tens of milliseconds, and the rest of the wait was pure
 * dead time repeated on every step of every run.
 *
 * A `MutationObserver` answers the real question. The timer restarts on each batch of
 * mutations, so "quiet" means the DOM genuinely stopped rather than that enough time
 * passed. `timeoutMs` bounds it, because a page with a ticking clock, a carousel, or a
 * long-polling widget never goes quiet at all and waiting forever would be worse than
 * the sleep this replaces.
 *
 * `requestAnimationFrame` before observing matters: mutations from the action itself can
 * still be queued, and starting the clock before they land would report quiet
 * immediately and hand the extractor a half-rendered page.
 */
function settle(request: SettleRequest): Promise<SettledResponse> {
  const started = performance.now();

  return new Promise<SettledResponse>((resolve) => {
    let mutations = 0;
    let done = false;
    let quietTimer: number | undefined;

    const finish = (quiet: boolean): void => {
      if (done) return;
      done = true;
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      clearTimeout(deadline);
      observer.disconnect();
      resolve({
        type: MSG.settled,
        quiet,
        waitedMs: Math.round(performance.now() - started),
        mutations,
      });
    };

    const restart = (): void => {
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      quietTimer = window.setTimeout(() => {
        finish(true);
      }, request.quietMs);
    };

    const observer = new MutationObserver((records) => {
      mutations += records.length;
      restart();
    });

    const deadline = window.setTimeout(() => {
      finish(false);
    }, request.timeoutMs);

    let watching = false;
    const startWatching = (): void => {
      if (done || watching) return;
      watching = true;
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      restart();
    };

    // A frame, or a short timer, whichever arrives first. The frame is the better signal
    // because it means the action's own mutations have landed — but a browser throttles
    // `requestAnimationFrame` in a tab that is not painting, and there it would never
    // arrive at all, leaving every action to sit out its full timeout.
    requestAnimationFrame(startWatching);
    window.setTimeout(startWatching, 32);
  });
}

function handle(request: ContentRequest): ContentResponse {
  switch (request.type) {
    case MSG.ping:
      return {
        type: MSG.pong,
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        devicePixelRatio: window.devicePixelRatio,
        respondedAt: Date.now(),
      };

    case MSG.observe: {
      // Drop entries for elements the page has since replaced, so the reported
      // registry size reflects live identity rather than accumulated history.
      registry.prune();

      const result = extractElementGraph(document, registry, {
        ...(request.maxNodes === undefined ? {} : { maxNodes: request.maxNodes }),
        ...(request.includeHidden === undefined
          ? {}
          : { includeHidden: request.includeHidden }),
        ...(request.includeStructural === undefined
          ? {}
          : { includeStructural: request.includeStructural }),
      });

      if (request.drawOverlay === true) {
        lastOverlayBoxes = drawOverlay(document, result.graph, { includeStructural: false });
      }

      return {
        type: MSG.observed,
        graph: result.graph,
        metrics: summarize(
          result.graph,
          result.durationMs,
          result.elementsVisited,
          request.drawOverlay === true ? lastOverlayBoxes : 0,
        ),
      };
    }

    case MSG.showOverlay: {
      const result = extractElementGraph(document, registry, {});
      lastOverlayBoxes = drawOverlay(document, result.graph, {
        includeStructural: request.includeStructural ?? false,
      });
      return { type: MSG.overlayState, visible: true, boxes: lastOverlayBoxes };
    }

    case MSG.hideOverlay:
      clearOverlay(document);
      lastOverlayBoxes = 0;
      return { type: MSG.overlayState, visible: false, boxes: 0 };

    case MSG.act:
    case MSG.settle:
      // Handled on the async path in the listener; unreachable here.
      return errorResponse(
        request.type,
        new Error('this request must be handled asynchronously'),
      );
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  // document_idle so layout has settled; getBoundingClientRect before that
  // returns geometry that is about to change.
  runAt: 'document_idle',
  allFrames: false,

  main() {
    // A declared content script is only injected into documents that load *after* the
    // extension starts, so every already-open tab has no reader in it. The panel
    // therefore injects this file programmatically when a ping goes unanswered, which
    // means `main` can run a second time in a tab that already has it.
    //
    // Without this guard that second run registers a second message listener and a
    // second pair of scroll/resize handlers, so every observation would be answered
    // twice and the overlay would repaint twice. Marking the window makes a repeat
    // injection a genuine no-op, which is what lets the caller inject freely rather
    // than having to track what it has already done.
    const marker = '__yuktiReaderInstalled';
    const host = window as unknown as Record<string, boolean | undefined>;
    if (host[marker] === true) return;
    host[marker] = true;

    browser.runtime.onMessage.addListener((message: unknown) => {
      if (!isContentRequest(message)) return undefined;
      try {
        // Actions await layout, so they take the async path. Everything else is
        // synchronous and returning a resolved promise keeps one return shape.
        if (message.type === MSG.act) {
          return act(message).catch((error: unknown) => errorResponse(MSG.act, error));
        }
        if (message.type === MSG.settle) {
          return settle(message).catch((error: unknown) => errorResponse(MSG.settle, error));
        }
        return Promise.resolve(handle(message));
      } catch (error) {
        return Promise.resolve(errorResponse(message.type, error));
      }
    });

    // Repaint the overlay after layout changes, otherwise the boxes drift away
    // from the elements they describe on scroll or resize.
    let repaintTimer: number | undefined;
    const scheduleRepaint = (): void => {
      if (!isOverlayVisible(document)) return;
      if (repaintTimer !== undefined) clearTimeout(repaintTimer);
      repaintTimer = window.setTimeout(() => {
        if (!isOverlayVisible(document)) return;
        const result = extractElementGraph(document, registry, {});
        lastOverlayBoxes = drawOverlay(document, result.graph, { includeStructural: false });
      }, 120);
    };

    window.addEventListener('scroll', scheduleRepaint, { passive: true });
    window.addEventListener('resize', scheduleRepaint, { passive: true });
  },
});
