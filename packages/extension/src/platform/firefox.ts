/**
 * Firefox adapter set.
 *
 * Firefox lacks four things Chrome extensions routinely lean on, and all four
 * shaped this architecture:
 *
 *   chrome.debugger / CDP        absent -> synthetic events only
 *   Accessibility.getFullAXTree  absent -> DOM walk is the only structure source
 *   chrome.offscreen             absent -> models run in the side panel instead
 *   persistent background        absent -> event page, no long-lived state
 *
 * The synthetic-event limitation is the one with real consequences. Events
 * dispatched from a content script carry `isTrusted: false`, and a site is
 * entirely within its rights to ignore them. Some flows will therefore behave
 * differently here than on Chrome. That gets measured and reported rather than
 * papered over.
 *
 * Capture, observation, and the model host are literally the same code as Chrome.
 * That sameness is the payoff of the abstraction.
 */

import type { BrowserCapabilities, PlatformAdapters } from '@sih/core';
import { createContentScriptObserve } from './observe-via-content.ts';
import { createContentScriptDispatch } from './dispatch-via-content.ts';
import { createCaptureAdapter } from './capture.ts';
import { createSidePanelModelHost } from './model-host.ts';

export function createFirefoxAdapters(capabilities: BrowserCapabilities): PlatformAdapters {
  return {
    browser: 'firefox',
    capabilities,
    capture: createCaptureAdapter('firefox:captureVisibleTab'),
    observe: createContentScriptObserve('firefox:content-script-walk'),
    dispatch: createContentScriptDispatch('firefox:synthetic-events', 'synthetic'),
    modelHost: createSidePanelModelHost('firefox:side-panel', 'side-panel', capabilities),
  };
}
