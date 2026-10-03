/**
 * Provider settings storage.
 *
 * Split deliberately across two places:
 *
 *  - endpoint, model, and limits go in `storage.local`. Not secret, and useful to
 *    be able to read without the vault being open.
 *  - the API key goes in the **vault**, as an `api_key` entry.
 *
 * Putting the key in the vault is not filing convenience. It gets the same
 * encryption as everything else, and — because the vault doubles as the redaction
 * dictionary — the key becomes something the redactor recognises and masks if it
 * ever shows up on a page. A credential pasted into the wrong place is exactly the
 * kind of accident this extension exists to catch.
 */

import { DEFAULT_SETTINGS, presetFor, type ProviderId, type ProviderSettings } from '@sih/core';
import * as vault from '../vault/index.ts';

const SETTINGS_KEY = 'kavach.provider.v1';

/** Fixed slot, so the key is always found in one place rather than searched for. */
const KEY_SLOT = 'provider_key';

type StorageArea = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

function storage(): StorageArea {
  const globals = globalThis as {
    chrome?: { storage?: { local?: StorageArea } };
    browser?: { storage?: { local?: StorageArea } };
  };
  const area = globals.chrome?.storage?.local ?? globals.browser?.storage?.local;
  if (area === undefined) throw new Error('extension storage is unavailable');
  return area;
}

interface StoredSettings {
  provider?: string;
  baseUrl?: string;
  model?: string;
  sendScreenshot?: boolean;
}

function isProviderId(value: unknown): value is ProviderId {
  return value === 'openrouter' || value === 'groq' || value === 'local' || value === 'custom';
}

export async function loadSettings(): Promise<ProviderSettings> {
  let raw: Record<string, unknown>;
  try {
    raw = await storage().get([SETTINGS_KEY]);
  } catch {
    return DEFAULT_SETTINGS;
  }

  const stored = raw[SETTINGS_KEY];
  const hasKey = vault.findByToken(`API_KEY_${KEY_SLOT.toUpperCase()}`) !== undefined;

  if (typeof stored !== 'object' || stored === null) {
    return { ...DEFAULT_SETTINGS, hasKey };
  }

  const candidate = stored as StoredSettings;
  const provider = isProviderId(candidate.provider)
    ? candidate.provider
    : DEFAULT_SETTINGS.provider;

  return {
    provider,
    baseUrl:
      typeof candidate.baseUrl === 'string' && candidate.baseUrl !== ''
        ? candidate.baseUrl
        : presetFor(provider).baseUrl,
    model: typeof candidate.model === 'string' ? candidate.model : '',
    hasKey,
    sendScreenshot:
      typeof candidate.sendScreenshot === 'boolean'
        ? candidate.sendScreenshot
        : DEFAULT_SETTINGS.sendScreenshot,
  };
}

export async function saveSettings(settings: ProviderSettings): Promise<void> {
  // `hasKey` is derived from the vault, so persisting it would let the two
  // disagree after a vault change.
  const toStore: StoredSettings = {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    sendScreenshot: settings.sendScreenshot,
  };
  await storage().set({ [SETTINGS_KEY]: toStore });
}

/**
 * Store the API key in the vault.
 *
 * Requires the vault to be open. The caller opens it automatically on startup, so
 * in practice this always succeeds; it throws rather than silently falling back to
 * plain storage, because a key written somewhere unencrypted would be a quiet
 * downgrade of the one guarantee this function exists to provide.
 */
export async function saveApiKey(key: string): Promise<void> {
  await vault.put({
    piiType: 'api_key',
    label: 'Reasoning provider key',
    value: key,
    slot: KEY_SLOT,
  });
}

export async function clearApiKey(): Promise<void> {
  await vault.remove(KEY_SLOT);
}

/**
 * Read the key back.
 *
 * Returns `undefined` rather than throwing when absent, because a local provider
 * legitimately needs no key and that is not an error.
 */
export async function readApiKey(): Promise<string | undefined> {
  try {
    return await vault.reveal(KEY_SLOT);
  } catch {
    return undefined;
  }
}

export function hasApiKey(): boolean {
  return vault.list().some((entry) => entry.slot === KEY_SLOT);
}

export { KEY_SLOT };
