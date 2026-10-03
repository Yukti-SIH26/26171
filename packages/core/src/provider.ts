/**
 * Remote reasoning provider.
 *
 * The extension talks to an OpenAI-compatible chat endpoint directly. There is no
 * backend of ours in the middle, and that is a deliberate architectural choice
 * rather than a shortcut: a relay would be one more machine holding the redacted
 * screenshot, one more thing to trust, and one more thing to secure. Direct is one
 * hop.
 *
 * The consequence is that the user supplies their own endpoint, key, and model.
 * Nothing is embedded in the extension, so nothing can be extracted from it, and
 * the same code covers a hosted API and a model running on the user's own machine —
 * which is how "offline deployable" is satisfied without a second implementation.
 */

export type ProviderId = 'openrouter' | 'groq' | 'local' | 'custom';

export interface ProviderPreset {
  readonly id: ProviderId;
  readonly label: string;
  readonly baseUrl: string;
  /** Whether a key is required. Local servers usually need none. */
  readonly needsKey: boolean;
  /** An example model name, shown as placeholder text rather than a default. */
  readonly exampleModel: string;
  /** One line the UI shows under the choice. */
  readonly note: string;
}

/**
 * Presets exist only to fill the URL field in. Every one of them is editable,
 * because a preset that cannot be overridden becomes a bug the moment a provider
 * changes a path.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    exampleModel: 'qwen/qwen3-vl-8b-instruct',
    note: '',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    exampleModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
    note: '',
  },
  {
    id: 'local',
    label: 'Local (Ollama, vLLM, LM Studio)',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    exampleModel: 'qwen2.5vl:7b',
    note: '',
  },
  {
    id: 'custom',
    label: 'Custom',
    baseUrl: '',
    needsKey: false,
    exampleModel: '',
    note: '',
  },
] as const;

export function presetFor(id: ProviderId): ProviderPreset {
  const found = PROVIDER_PRESETS.find((p) => p.id === id);
  // The union is closed, so this cannot miss; the fallback keeps the return type
  // non-optional for callers.
  return found ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]!;
}

export interface ProviderSettings {
  readonly provider: ProviderId;
  readonly baseUrl: string;
  readonly model: string;
  /**
   * Whether a key has been saved. The key itself lives in the vault and never
   * appears in this object, so settings can be logged or rendered safely.
   */
  readonly hasKey: boolean;
  /**
   * Send the redacted screenshot as well as the page structure.
   *
   * There is deliberately no step cap alongside this. A fixed budget cuts off long
   * but legitimate tasks and does nothing about a model that is genuinely stuck —
   * the loop detects repetition directly instead, and the Stop button is always
   * live.
   */
  readonly sendScreenshot: boolean;
}

export const DEFAULT_SETTINGS: ProviderSettings = {
  provider: 'openrouter',
  baseUrl: presetFor('openrouter').baseUrl,
  model: '',
  hasKey: false,
  sendScreenshot: true,
};

export type SettingsProblem =
  'no_base_url' | 'bad_base_url' | 'no_model' | 'no_key' | 'insecure_remote';

export interface SettingsCheck {
  readonly ok: boolean;
  readonly problems: readonly SettingsProblem[];
  readonly messages: readonly string[];
}

/**
 * Validate settings without touching the network.
 *
 * Catching a blank model name here turns a confusing mid-task failure into a
 * message next to the field that caused it.
 */
export function checkSettings(settings: ProviderSettings): SettingsCheck {
  const problems: SettingsProblem[] = [];
  const messages: string[] = [];

  if (settings.baseUrl.trim() === '') {
    problems.push('no_base_url');
    messages.push('Enter the server address.');
  } else {
    let parsed: URL | undefined;
    try {
      parsed = new URL(settings.baseUrl);
    } catch {
      problems.push('bad_base_url');
      messages.push('That server address is not a valid URL.');
    }

    // Plain HTTP is fine for a loopback address and nowhere else: to a remote host
    // it would put the redacted page, and the key, on the wire in clear text.
    if (parsed !== undefined && parsed.protocol === 'http:') {
      // `URL` keeps the brackets on an IPv6 hostname, so `http://[::1]/` reports
      // `[::1]` rather than `::1`. Comparing without stripping them silently treats
      // IPv6 loopback as a remote host.
      const host = parsed.hostname.replace(/^\[|\]$/g, '');
      const local =
        host === 'localhost' ||
        host === '::1' ||
        host.endsWith('.localhost') ||
        // Whole 127.0.0.0/8 range, not just 127.0.0.1.
        /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
      if (!local) {
        problems.push('insecure_remote');
        messages.push(
          'Use https for a remote server. Over plain http the page contents and your key ' +
            'travel unencrypted.',
        );
      }
    }
  }

  if (settings.model.trim() === '') {
    problems.push('no_model');
    messages.push('Enter the model name exactly as the provider spells it.');
  }

  if (presetFor(settings.provider).needsKey && !settings.hasKey) {
    problems.push('no_key');
    messages.push('This provider needs an API key.');
  }

  return { ok: problems.length === 0, problems, messages };
}

/** Host match pattern for the permission request the fetch will need. */
export function hostPatternFor(baseUrl: string): string | undefined {
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.protocol}//${parsed.host}/*`;
  } catch {
    return undefined;
  }
}
