/**
 * OpenAI-compatible chat client.
 *
 * One code path covers OpenRouter, Groq, Ollama, vLLM, and LM Studio, because they
 * all speak the same `/chat/completions` shape. That is the reason the settings are
 * a URL and a model name rather than a provider integration each.
 *
 * Called from the side panel, not a content script. The distinction matters: an
 * extension page with host permission fetches with the extension's own privileges,
 * so CORS does not apply. A content script would be subject to the page's CORS
 * rules and this would not work.
 */

import { hostPatternFor, type ProviderSettings } from '@sih/core';
import { browser } from 'wxt/browser';

/** Give up rather than hang. A stalled request should surface, not freeze the UI. */
const REQUEST_TIMEOUT_MS = 90_000;

export class ProviderError extends Error {
  readonly status?: number;
  /** True when retrying could plausibly help: rate limit, timeout, 5xx. */
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'ProviderError';
    if (options.status !== undefined) this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export interface TextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface ImagePart {
  readonly type: 'image_url';
  readonly image_url: { readonly url: string };
}

export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string | readonly ContentPart[];
}

export interface ChatResult {
  readonly text: string;
  readonly model: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly durationMs: number;
}

interface ApiChoice {
  message?: { content?: unknown };
}

interface ApiResponse {
  choices?: ApiChoice[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: unknown };
}

function joinUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}${path}`;
}

/**
 * Make sure we may talk to this host.
 *
 * `<all_urls>` is granted at install, so every https endpoint is already covered and
 * there is nothing to ask for. What remains is a plain http address, which only
 * `optional_host_permissions` covers and which in practice means a model server on
 * loopback.
 *
 * This used to request a permission unconditionally. Prompting for something already
 * held is not harmless: Chrome shows no dialog, `request` resolves false outside a live
 * user gesture, and Connect then reported "access was not granted" for an endpoint it
 * could have reached perfectly well.
 */
export async function ensureProviderAccess(baseUrl: string): Promise<boolean> {
  const pattern = hostPatternFor(baseUrl);
  if (pattern === undefined) return false;
  try {
    if (await browser.permissions.contains({ origins: [pattern] })) return true;
    return await browser.permissions.request({ origins: [pattern] });
  } catch {
    // Firefox rejects `contains` for patterns outside the manifest rather than
    // answering false. Treat that as "nothing more to ask" and let the request itself
    // report the truth.
    return true;
  }
}

function headersFor(apiKey: string | undefined): HeadersInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey !== undefined && apiKey !== '') headers.Authorization = `Bearer ${apiKey}`;

  // OpenRouter uses these for attribution and will reject some browser-origin
  // requests without them. Harmless everywhere else, and deliberately generic —
  // no user or page information goes in either field.
  headers['HTTP-Referer'] = 'https://github.com/yukti-agent';
  headers['X-Title'] = 'Yukti';

  return headers;
}

/**
 * Turn a failed response into an error that names the likely cause.
 *
 * Status codes here are the ones a user will actually hit while setting this up, and
 * each gets the fix rather than the code.
 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as ApiResponse;
    return typeof body.error?.message === 'string' ? body.error.message : '';
  } catch {
    return '';
  }
}

async function toError(response: Response): Promise<ProviderError> {
  const detail = await readErrorDetail(response);
  const suffix = detail === '' ? '' : ` — ${detail}`;

  switch (response.status) {
    case 401:
    case 403:
      return new ProviderError(`The API key was rejected${suffix}`, {
        status: response.status,
      });
    case 404:
      return new ProviderError(
        `Not found. Check the server address and that the model name is spelled the way the ` +
          `provider spells it${suffix}`,
        { status: 404 },
      );
    case 413:
      return new ProviderError(
        `The request was too large. Turn the screenshot off, or use a smaller one${suffix}`,
        { status: 413 },
      );
    case 429:
      return new ProviderError(`Rate limited by the provider${suffix}`, {
        status: 429,
        retryable: true,
      });
    default:
      return new ProviderError(
        response.status >= 500
          ? `The provider had a server error (${String(response.status)})${suffix}`
          : `Request failed (${String(response.status)})${suffix}`,
        { status: response.status, retryable: response.status >= 500 },
      );
  }
}

export interface ChatOptions {
  readonly settings: ProviderSettings;
  readonly apiKey?: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number;
  /** Low by default: we want a decision, not prose. */
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export async function chat(options: ChatOptions): Promise<ChatResult> {
  const { settings, apiKey, messages } = options;
  const started = performance.now();

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  // Caller-supplied aborts (the Stop button) have to compose with the timeout.
  const onAbort = (): void => {
    controller.abort();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(joinUrl(settings.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: headersFor(apiKey),
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: options.temperature ?? 0.1,
        max_tokens: options.maxTokens ?? 900,
        stream: false,
      }),
    });

    if (!response.ok) throw await toError(response);

    const body = (await response.json()) as ApiResponse;
    const content = body.choices?.[0]?.message?.content;

    // Some providers return content as an array of parts even for text-only
    // replies, so both shapes have to be handled or the reply reads as empty.
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((part) =>
                typeof part === 'object' && part !== null && 'text' in part
                  ? String((part as { text: unknown }).text)
                  : '',
              )
              .join('')
          : '';

    if (text.trim() === '') {
      throw new ProviderError('The model returned an empty reply', { retryable: true });
    }

    return {
      text,
      model: body.model ?? settings.model,
      ...(body.usage?.prompt_tokens === undefined
        ? {}
        : { promptTokens: body.usage.prompt_tokens }),
      ...(body.usage?.completion_tokens === undefined
        ? {}
        : { completionTokens: body.usage.completion_tokens }),
      durationMs: performance.now() - started,
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ProviderError(
        options.signal?.aborted === true
          ? 'Stopped'
          : `No reply within ${String(REQUEST_TIMEOUT_MS / 1000)} seconds`,
        { retryable: true },
      );
    }
    // A bare "Failed to fetch" is the single most confusing failure here, so it
    // gets the three real causes named instead.
    throw new ProviderError(
      `Could not reach ${settings.baseUrl}. Check the address, that the server is running, ` +
        `and that you granted access to it.`,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export interface ConnectResult {
  readonly ok: boolean;
  readonly message: string;
  readonly model?: string;
  readonly durationMs?: number;
}

/**
 * Prove the endpoint, key, and model all work.
 *
 * One tiny request. Doing this from a button means a typo in the model name shows up
 * next to the field that caused it, instead of three steps into an agent run where
 * it looks like the agent is broken.
 */
export async function connect(
  settings: ProviderSettings,
  apiKey?: string,
): Promise<ConnectResult> {
  const allowed = await ensureProviderAccess(settings.baseUrl);
  if (!allowed) {
    return {
      ok: false,
      message: `Access to ${settings.baseUrl} was not granted, so it cannot be contacted.`,
    };
  }

  try {
    const result = await chat({
      settings,
      ...(apiKey === undefined ? {} : { apiKey }),
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      maxTokens: 12,
    });
    return {
      ok: true,
      message: `Connected to ${result.model} in ${result.durationMs.toFixed(0)} ms.`,
      model: result.model,
      durationMs: result.durationMs,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Could not connect.',
    };
  }
}
