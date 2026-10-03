/**
 * Navigation that actually waits.
 *
 * `tabs.update()` resolves the moment the browser *accepts* the navigation, not when
 * the page has loaded. The previous version slept 1800 ms afterwards and hoped,
 * which is why the agent so often read the page it had just left, or read nothing at
 * all because the content script had not injected yet.
 *
 * That failure is nasty because it is silent: element ids from the old page still
 * resolve against the old graph, so the agent confidently clicks something that is
 * no longer there and the log looks fine.
 *
 * So navigation waits on two real signals instead of a guess:
 *
 *   1. the tab reports `status: 'complete'` for the URL we asked for
 *   2. the content script answers a ping
 *
 * Both are needed. `complete` means the document finished loading; the ping means our
 * extractor is actually present and able to answer. A page can satisfy the first and
 * not the second for a noticeable window, and that window is exactly where the old
 * bug lived.
 */

import { browser } from 'wxt/browser';
import { MSG, isPongResponse, isSettledResponse } from '../messaging/protocol.ts';
import { ensureContentScript } from './inject.ts';

/** Total time to wait for a navigation to settle before giving up. */
const LOAD_TIMEOUT_MS = 20_000;

/** How long to keep pinging for the content script after the document is ready. */
const SCRIPT_TIMEOUT_MS = 8_000;

const PING_INTERVAL_MS = 150;

export class NavigationError extends Error {
  readonly url: string;

  constructor(url: string, reason: string) {
    super(reason);
    this.name = 'NavigationError';
    this.url = url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the content script in this tab answers.
 *
 * Polling rather than listening for an announcement: the script may already be
 * loaded and idle, in which case there is no event left to catch. A ping that
 * succeeds is proof of presence regardless of timing, which an event is not.
 */
export async function waitForContentScript(
  tabId: number,
  timeoutMs = SCRIPT_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await browser.tabs.sendMessage(tabId, { type: MSG.ping });
      if (isPongResponse(response)) return true;
    } catch {
      // No receiving end yet. Expected while the document is still coming up.
    }
    await sleep(PING_INTERVAL_MS);
  }

  // Declared injection never happened, or happened and was lost. Ask for it explicitly
  // rather than reporting the page as unreadable: a navigation that lands on a
  // perfectly good page still leaves an already-open tab without a reader, and waiting
  // longer would not have produced one.
  try {
    await ensureContentScript(tabId);
    return true;
  } catch {
    // A page no extension may script. The caller treats this as `readable: false`,
    // which is information rather than a failure.
    return false;
  }
}

/**
 * Where the tab actually is.
 *
 * Falls back rather than throwing: a tab can be closed mid-navigation, and the
 * caller's best available answer is the URL it asked for.
 */
async function urlOf(tabId: number, fallback: string): Promise<string> {
  try {
    const tab = await browser.tabs.get(tabId);
    return tab.url ?? fallback;
  } catch {
    return fallback;
  }
}

/** Is the tab's document finished loading? */
async function isComplete(tabId: number): Promise<boolean> {
  try {
    const tab = await browser.tabs.get(tabId);
    return tab.status === 'complete';
  } catch {
    return false;
  }
}

/**
 * Wait for the tab to finish loading.
 *
 * Uses `onUpdated` for the signal and polls as a safety net: a load that completed
 * between the caller's last look and this listener being attached would otherwise
 * never fire an event, and the wait would hang for the full timeout.
 */
async function waitForLoad(tabId: number, timeoutMs: number): Promise<boolean> {
  if (await isComplete(tabId)) return true;

  return new Promise<boolean>((resolve) => {
    let settled = false;

    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      browser.tabs.onUpdated.removeListener(onUpdated);
      clearInterval(poll);
      clearTimeout(timer);
      resolve(value);
    };

    const onUpdated = (updatedTabId: number, changeInfo: { status?: string }): void => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish(true);
    };

    browser.tabs.onUpdated.addListener(onUpdated);

    const poll = setInterval(() => {
      void isComplete(tabId).then((done) => {
        if (done) finish(true);
      });
    }, 250);

    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

/**
 * Ask the page when it has stopped changing, falling back to a plain wait.
 *
 * The fallback is not a rare path: a click that navigates tears the content script down
 * mid-request, and `sendMessage` then rejects. Sleeping the remainder of the budget there
 * preserves the old behaviour exactly, so replacing the sleep cannot make a navigating
 * click *worse* than it was — the caller checks the URL straight afterwards and waits on
 * the destination properly anyway.
 */
async function waitForQuietDom(tabId: number, budgetMs: number): Promise<void> {
  const started = Date.now();

  try {
    const response = await browser.tabs.sendMessage(tabId, {
      type: MSG.settle,
      quietMs: QUIET_MS,
      timeoutMs: budgetMs,
    });
    if (isSettledResponse(response)) return;
  } catch {
    // No reader in the page, or it went away mid-action. Fall through.
  }

  // Bounded, and deliberately not the rest of the budget. Reaching here almost always
  // means the click navigated and took the content script with it, and the caller is
  // about to wait for the destination properly — so a long sleep here would be spent
  // twice over.
  const remaining = Math.min(budgetMs - (Date.now() - started), 400);
  if (remaining > 0) await sleep(remaining);
}

export interface NavigationResult {
  /** Where the tab actually ended up, which may differ after a redirect. */
  readonly url: string;
  /** True when the content script is present and answering. */
  readonly readable: boolean;
  readonly durationMs: number;
}

/**
 * Navigate and wait until the page is genuinely ready to be read.
 *
 * `readable: false` is returned rather than thrown for a page that loads but cannot
 * be scripted — a PDF viewer, a download, a browser-internal redirect. That is
 * information the agent can act on, not a failure of the navigation.
 */
export async function navigateAndWait(tabId: number, url: string): Promise<NavigationResult> {
  const started = performance.now();

  try {
    await browser.tabs.update(tabId, { url });
  } catch (error) {
    throw new NavigationError(
      url,
      `could not open it: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  const loaded = await waitForLoad(tabId, LOAD_TIMEOUT_MS);

  // Read back rather than trust the request: a redirect is the normal case, and the
  // caller needs to know where it actually ended up.
  const finalUrl = await urlOf(tabId, url);

  if (!loaded) {
    // A slow page is still worth trying to read: plenty of sites never reach
    // `complete` because of long-polling or a stalled tracker, yet are perfectly
    // usable. So this is a note, not an error.
    const readable = await waitForContentScript(tabId, 2000);
    return { url: finalUrl, readable, durationMs: performance.now() - started };
  }

  const readable = await waitForContentScript(tabId);
  return { url: finalUrl, readable, durationMs: performance.now() - started };
}

/** Go back or forward, waiting for the result the same way. */
export async function historyAndWait(
  tabId: number,
  direction: 'back' | 'forward',
): Promise<NavigationResult> {
  const started = performance.now();

  try {
    if (direction === 'back') await browser.tabs.goBack(tabId);
    else await browser.tabs.goForward(tabId);
  } catch (error) {
    throw new NavigationError(
      direction,
      `could not go ${direction}: ${error instanceof Error ? error.message : 'no history'}`,
    );
  }

  await waitForLoad(tabId, LOAD_TIMEOUT_MS);
  const url = await urlOf(tabId, 'about:blank');

  const readable = await waitForContentScript(tabId);
  return { url, readable, durationMs: performance.now() - started };
}

/**
 * How still the DOM must be before the page counts as settled.
 *
 * Short on purpose. This is not "how long could a page possibly take" — it is "how long
 * a page that has finished stays finished", and a page that has finished re-rendering
 * stops mutating immediately. Anything still arriving restarts the clock, so a slow page
 * gets all the time it needs without a fast one paying for it.
 */
const QUIET_MS = 90;

/**
 * Wait for the page to settle after an action that was not a navigation.
 *
 * A click can trigger one — a link, a form submit, a router push — and it can also
 * do nothing but open a menu. So this waits only as long as it needs to: if the URL
 * changed it waits for the new page properly, otherwise it waits for the DOM to stop
 * changing and returns.
 *
 * `budgetMs` is a ceiling, not a duration. It used to be spent unconditionally on every
 * action — 700 ms after a click, 900 ms after a submit — which on a fifteen-field form
 * was most of the run's wall-clock time spent watching a page that had already finished.
 * Now the page says when it is done and the budget only applies when it never does,
 * which is the case for a carousel, a clock, or a long-polling widget.
 */
export async function settleAfterAction(
  tabId: number,
  urlBefore: string,
  budgetMs: number,
): Promise<NavigationResult> {
  const started = performance.now();
  await waitForQuietDom(tabId, budgetMs);

  const after = await urlOf(tabId, urlBefore);

  if (after === urlBefore) {
    // Same page. The content script survived, so no need to wait for it.
    return { url: after, readable: true, durationMs: performance.now() - started };
  }

  // It navigated. Wait for the destination the same way as an explicit navigation.
  await waitForLoad(tabId, LOAD_TIMEOUT_MS);
  const url = await urlOf(tabId, after);

  const readable = await waitForContentScript(tabId);
  return { url, readable, durationMs: performance.now() - started };
}
