/**
 * Chrome adapter set.
 *
 * Chrome is the richer platform, but the extra capabilities are treated as
 * accelerators rather than foundations:
 *
 *  - `chrome.debugger` gives CDP, and CDP gives trusted input events. Real value
 *    on hardened sites, but Firefox has no equivalent, so no logic above this
 *    layer may assume it.
 *  - `chrome.offscreen` gives a long-lived DOM context for model inference. Not
 *    used yet: the side-panel host works on both browsers, and a Chrome-only
 *    model host would fork the perception layer.
 *
 * Observation stays on the portable content-script path even here. Using CDP's
 * accessibility tree would produce a Chrome-only perception layer, which is the
 * mistake this whole abstraction exists to prevent.
 */

import type { BrowserCapabilities, PlatformAdapters } from '@sih/core';
import { createContentScriptObserve } from './observe-via-content.ts';
import { createContentScriptDispatch } from './dispatch-via-content.ts';
import { createCaptureAdapter } from './capture.ts';
import { createSidePanelModelHost } from './model-host.ts';

export function createChromeAdapters(capabilities: BrowserCapabilities): PlatformAdapters {
  return {
    browser: 'chrome',
    capabilities,
    // `tabs.captureVisibleTab` under the `<all_urls>` host permission. It returns
    // exactly the named tab's visible viewport, so redaction geometry lines up by
    // construction rather than by measurement.
    capture: createCaptureAdapter('chrome:captureVisibleTab'),
    observe: createContentScriptObserve('chrome:content-script-walk'),
    // Synthetic events, same as Firefox. The `debugger` permission is declared and
    // would give genuinely trusted input, but wiring the executor to CDP here
    // would mean maintaining two executors and letting the Firefox one rot. The
    // portable path is the real one; CDP becomes an opt-in accelerator only once
    // measurement shows a site that actually needs it.
    dispatch: createContentScriptDispatch('chrome:synthetic-events', 'synthetic'),
    modelHost: createSidePanelModelHost('chrome:side-panel', 'side-panel', capabilities),
  };
}
