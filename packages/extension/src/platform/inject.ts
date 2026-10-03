/**
 * Getting the page reader into the page.
 *
 * The content script is declared in the manifest with `matches: ['<all_urls>']`, and
 * that was assumed to be sufficient. It is not, and the gap is the single reason
 * nothing worked on the page in front of the user:
 *
 * **A declared content script is only injected into documents that load after the
 * extension starts.** Every tab already open when the extension was installed,
 * enabled, reloaded, or updated has no reader in it, and the browser will not
 * retrofit one.
 *
 * So the failure is worst at exactly the wrong moment. You reload the extension to
 * pick up a change, and reloading is the thing that detaches the reader from every tab
 * you had open — including the one you are looking at. `tabs.sendMessage` then rejects
 * with "receiving end does not exist", which the agent honestly reported as "the page
 * could not be read", and the model correctly gave up. Nothing about the page was
 * wrong; there was simply nobody home.
 *
 * The fix is to stop treating declared injection as a guarantee. Ping; if nobody
 * answers, inject and ping again. `scripting` and the `<all_urls>` host permission are
 * already held, so this needs no new grant.
 *
 * What genuinely cannot be reached stays unreachable, and that is correct — a
 * browser-internal page, an extension store, a PDF viewer. Those are refusals from the
 * browser rather than missing setup, so they get their own error type and the caller
 * degrades to working without a page instead of reporting a fault.
 */

import { browser } from 'wxt/browser';
import { MSG, isPongResponse } from '../messaging/protocol.ts';

/**
 * Path of the built content script inside the extension.
 *
 * A build output, not a source path, which is why it is a literal: importing the
 * module would bundle the extractor into the side panel instead of injecting it into
 * the page. Kept in step with the `content` entrypoint that WXT emits.
 */
const CONTENT_SCRIPT = '/content-scripts/content.js';

/** How long to keep pinging after an injection before calling it a failure. */
const READY_TIMEOUT_MS = 3000;
const PING_INTERVAL_MS = 100;

/**
 * Thrown when a page cannot host the reader at all.
 *
 * Distinct from a transient failure on purpose: the caller should stop trying and tell
 * the user which kind of page this is, not retry.
 */
export class NotScriptableError extends Error {
  readonly url: string;

  constructor(url: string, reason: string) {
    super(reason);
    this.name = 'NotScriptableError';
    this.url = url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Is the page reader answering in this tab right now? */
export async function isContentScriptAlive(tabId: number): Promise<boolean> {
  try {
    return isPongResponse(await browser.tabs.sendMessage(tabId, { type: MSG.ping }));
  } catch {
    // "Receiving end does not exist" is the expected answer for a tab with no reader,
    // so this is a normal outcome rather than an error worth propagating.
    return false;
  }
}

/**
 * Pages no extension may script.
 *
 * Checked before attempting an injection so the failure can be described accurately.
 * Letting `executeScript` throw would also work, but the resulting message suggests
 * something is broken rather than that the browser is refusing on principle.
 */
function scriptableRefusal(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return 'that tab has no address yet.';

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'that tab has no readable address.';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'this is a browser page, and no extension is allowed to read one. Open a website first.';
  }
  // Both vendors block extension scripting on their own add-on storefronts.
  const host = parsed.hostname;
  if (
    host === 'chrome.google.com' ||
    host === 'chromewebstore.google.com' ||
    host === 'addons.mozilla.org'
  ) {
    return 'the browser blocks extensions from reading its own store pages.';
  }
  return undefined;
}

/**
 * Make sure the page reader is present and answering in this tab.
 *
 * Cheap on the happy path — one ping — so it is safe to call before every observation.
 * That is what makes an already-open tab work without the user needing to know they
 * were supposed to reload it.
 *
 * Injecting twice is harmless: the content script marks the window on first run and
 * returns early afterwards, so a lost race between two callers costs nothing.
 */
export async function ensureContentScript(tabId: number): Promise<void> {
  if (await isContentScriptAlive(tabId)) return;

  let url: string | undefined;
  try {
    url = (await browser.tabs.get(tabId)).url;
  } catch {
    throw new NotScriptableError('unknown', 'that tab is gone.');
  }

  const refusal = scriptableRefusal(url);
  if (refusal !== undefined) throw new NotScriptableError(url ?? 'unknown', refusal);

  try {
    await browser.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: [CONTENT_SCRIPT],
    });
  } catch (error) {
    throw new NotScriptableError(
      url ?? 'unknown',
      `this page will not let the reader load: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }

  // `executeScript` resolves once the file has been evaluated, but the message
  // listener is registered *during* that evaluation, so a ping fired immediately after
  // can still lose the race. Polling is the difference between this working reliably
  // and working most of the time.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isContentScriptAlive(tabId)) return;
    await sleep(PING_INTERVAL_MS);
  }

  throw new NotScriptableError(
    url ?? 'unknown',
    'the reader loaded but never answered. Reload the page and try again.',
  );
}
