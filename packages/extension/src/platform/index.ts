/**
 * Platform resolution.
 *
 * One call site decides which adapter set is in play. Everything above this
 * point programs against the `PlatformAdapters` interface and never branches on
 * browser identity, which is what keeps a single codebase honest across two
 * quite different extension platforms.
 */

import type { BrowserCapabilities, PlatformAdapters } from '@sih/core';
import { UnsupportedPlatformError } from '@sih/core';
import { probeCapabilities } from './probe.ts';
import { createChromeAdapters } from './chrome.ts';
import { createFirefoxAdapters } from './firefox.ts';

export function createAdapters(capabilities: BrowserCapabilities): PlatformAdapters {
  switch (capabilities.browser) {
    case 'chrome':
      return createChromeAdapters(capabilities);
    case 'firefox':
      return createFirefoxAdapters(capabilities);
    default:
      throw new UnsupportedPlatformError(
        capabilities.browser,
        'platform resolution',
        'only Chrome and Firefox builds are supported',
      );
  }
}

/** Probe the environment and resolve adapters in one step. */
export async function initPlatform(): Promise<PlatformAdapters> {
  const capabilities = await probeCapabilities();
  return createAdapters(capabilities);
}

export { probeCapabilities } from './probe.ts';
export { createChromeAdapters } from './chrome.ts';
export { createFirefoxAdapters } from './firefox.ts';
