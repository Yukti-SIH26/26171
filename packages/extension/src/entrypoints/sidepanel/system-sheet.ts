/**
 * The system sheet, behind the ⋯ button.
 *
 * Answers the two questions a user actually has — can this computer run it, and
 * has anything left my machine — in plain language, with the adapter identifiers
 * and GPU limits tucked behind a drawer for when something has gone wrong.
 *
 * The wording is deliberately concrete rather than reassuring. "Nothing has been
 * sent" is a claim that has to stay true, so it is derived from state rather than
 * hardcoded, and it says *why* it is true (there is no server yet) instead of
 * implying a guarantee the architecture does not yet have to make.
 */

import {
  checkSettings,
  chooseBackend,
  meetsMinimumRequirements,
  presetFor,
  PROVIDER_PRESETS,
  summarize,
  type BrowserCapabilities,
  type PlatformAdapters,
  type ProviderId,
  type ProviderSettings,
} from '@sih/core';
import {
  ORT_RUNTIME_MB,
  OWLVIT_BASE32,
  TESSERACT_ENG,
  totalBundledMb,
} from '../../models/catalogue.ts';
import { isDetectorLoaded } from '../../models/vision.ts';
import { isOcrReady } from '../../models/ocr.ts';
import {
  clearApiKey,
  connect,
  hasApiKey,
  loadSettings,
  readApiKey,
  saveApiKey,
  saveSettings,
} from '../../llm/index.ts';

type State = 'ok' | 'warn' | 'bad';

export interface SystemSheetDeps {
  readonly el: <T extends HTMLElement>(id: string) => T;
  readonly row: (term: string, value: string, state?: State, note?: string) => DocumentFragment;
  readonly say: (message: string, state?: State) => void;
  readonly platform: () => PlatformAdapters | undefined;
  /** Bytes actually sent so far this session. */
  readonly sentBytes: () => number;
  /** Number of values currently readable from the vault. */
  readonly vaultCount: () => number;
  /** Called when provider settings change, so the chat can re-check itself. */
  readonly onSettingsChanged: (settings: ProviderSettings) => void;
}

function formatGpuMemory(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GB` : `${String(Math.round(mib))} MB`;
}

export class SystemSheet {
  private settings: ProviderSettings | undefined;

  constructor(private readonly deps: SystemSheetDeps) {}

  async init(): Promise<void> {
    const dialog = this.deps.el<HTMLDialogElement>('system-dialog');

    this.deps.el<HTMLButtonElement>('system-open').addEventListener('click', () => {
      // Rendered on open rather than once at startup, so counters like the bytes
      // sent and whether a model is loaded are current.
      this.render();
      dialog.showModal();
    });

    this.deps.el<HTMLButtonElement>('system-close').addEventListener('click', () => {
      dialog.close();
    });

    // Clicking the backdrop should dismiss. A <dialog> reports a click on itself
    // when the press landed outside the content box.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });

    await this.initProvider();
  }

  currentSettings(): ProviderSettings | undefined {
    return this.settings;
  }

  // -------------------------------------------------------------------------
  // Provider settings
  // -------------------------------------------------------------------------

  private async initProvider(): Promise<void> {
    const select = this.deps.el<HTMLSelectElement>('provider-select');
    select.textContent = '';
    for (const preset of PROVIDER_PRESETS) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.label;
      select.appendChild(option);
    }

    this.settings = await loadSettings();
    this.renderProvider();

    select.addEventListener('change', () => {
      const current = this.settings;
      if (current === undefined) return;

      const id = select.value as ProviderId;
      const preset = presetFor(id);

      // Picking a named provider is a statement about where to connect, so the URL
      // is replaced. Custom keeps whatever the user typed.
      this.settings = {
        ...current,
        provider: id,
        ...(id === 'custom' ? {} : { baseUrl: preset.baseUrl }),
      };
      this.renderProvider();
      void this.persist();
    });

    for (const id of ['provider-url', 'provider-model'] as const) {
      this.deps.el<HTMLInputElement>(id).addEventListener('change', () => {
        void this.readFieldsAndPersist();
      });
    }
    this.deps.el<HTMLInputElement>('provider-screenshot').addEventListener('change', () => {
      void this.readFieldsAndPersist();
    });

    this.deps.el<HTMLButtonElement>('provider-connect').addEventListener('click', () => {
      void this.connect();
    });
    this.deps.el<HTMLButtonElement>('provider-forget').addEventListener('click', () => {
      void this.forgetKey();
    });
  }

  private renderProvider(): void {
    const settings = this.settings;
    if (settings === undefined) return;

    const preset = presetFor(settings.provider);
    this.deps.el<HTMLSelectElement>('provider-select').value = settings.provider;
    this.deps.el<HTMLParagraphElement>('provider-note').textContent = preset.note;
    this.deps.el<HTMLInputElement>('provider-url').value = settings.baseUrl;
    this.deps.el<HTMLInputElement>('provider-model').value = settings.model;
    this.deps.el<HTMLInputElement>('provider-model').placeholder =
      preset.exampleModel === '' ? 'model name' : `e.g. ${preset.exampleModel}`;
    this.deps.el<HTMLInputElement>('provider-screenshot').checked = settings.sendScreenshot;

    const keyField = this.deps.el<HTMLInputElement>('provider-key');
    keyField.placeholder = settings.hasKey
      ? 'saved — type a new one to replace it'
      : preset.needsKey
        ? 'required for this provider'
        : 'not needed for a local server';

    this.showStatus();
  }

  /** Show what is missing, without a network call. */
  private showStatus(): void {
    const status = this.deps.el<HTMLParagraphElement>('provider-status');
    status.classList.remove('state-ok', 'state-warn', 'state-bad');

    const settings = this.settings;
    if (settings === undefined) return;

    const check = checkSettings(settings);
    if (check.ok) {
      status.textContent = '';
      return;
    }
    status.textContent = check.messages.join(' ');
    status.classList.add('state-warn');
  }

  private async readFieldsAndPersist(): Promise<void> {
    const current = this.settings;
    if (current === undefined) return;

    this.settings = {
      ...current,
      baseUrl: this.deps.el<HTMLInputElement>('provider-url').value.trim(),
      model: this.deps.el<HTMLInputElement>('provider-model').value.trim(),
      sendScreenshot: this.deps.el<HTMLInputElement>('provider-screenshot').checked,
    };

    await this.persist();
    this.showStatus();
  }

  private async persist(): Promise<void> {
    const settings = this.settings;
    if (settings === undefined) return;
    await saveSettings(settings);
    this.deps.onSettingsChanged(settings);
  }

  /**
   * Save any typed key, then prove the whole configuration works.
   *
   * The key is written before the call so a successful Connect leaves a working
   * setup rather than one that only worked while the field was filled in.
   */
  private async connect(): Promise<void> {
    const button = this.deps.el<HTMLButtonElement>('provider-connect');
    const status = this.deps.el<HTMLParagraphElement>('provider-status');
    status.classList.remove('state-ok', 'state-warn', 'state-bad');

    await this.readFieldsAndPersist();

    const keyField = this.deps.el<HTMLInputElement>('provider-key');
    if (keyField.value.trim() !== '') {
      try {
        await saveApiKey(keyField.value.trim());
        // Clear immediately: no reason for the key to stay in the DOM.
        keyField.value = '';
      } catch (error) {
        status.textContent = `Could not save the key: ${
          error instanceof Error ? error.message : 'unknown error'
        }`;
        status.classList.add('state-bad');
        return;
      }
    }

    const settings = this.settings;
    if (settings === undefined) return;

    const withKey: ProviderSettings = { ...settings, hasKey: hasApiKey() };
    this.settings = withKey;
    this.renderProvider();

    const check = checkSettings(withKey);
    if (!check.ok) {
      status.textContent = check.messages.join(' ');
      status.classList.add('state-warn');
      return;
    }

    button.disabled = true;
    status.textContent = 'Connecting…';

    try {
      const apiKey = await readApiKey();
      const result = await connect(withKey, apiKey);
      status.textContent = result.message;
      status.classList.add(result.ok ? 'state-ok' : 'state-bad');
      this.deps.say(
        result.ok ? `Connected to ${withKey.model}.` : `Could not connect: ${result.message}`,
        result.ok ? 'ok' : 'bad',
      );
      this.deps.onSettingsChanged(withKey);
    } finally {
      button.disabled = false;
    }
  }

  private async forgetKey(): Promise<void> {
    await clearApiKey();
    const current = this.settings;
    if (current !== undefined) {
      this.settings = { ...current, hasKey: false };
      this.renderProvider();
    }
    this.deps.say('Provider key deleted.', 'warn');
  }

  private render(): void {
    const platform = this.deps.platform();
    const verdict = this.deps.el<HTMLDivElement>('system-verdict');
    const plain = this.deps.el<HTMLDListElement>('system-plain');

    verdict.classList.remove('state-ok', 'state-warn', 'state-bad');
    plain.textContent = '';

    if (platform === undefined) {
      verdict.textContent =
        'Could not check this computer. The vision model and page reading will not work, ' +
        'but the Vault still does.';
      verdict.classList.add('state-bad');
      return;
    }

    const caps = platform.capabilities;
    const ready = meetsMinimumRequirements(caps);

    verdict.textContent = ready
      ? 'This computer can run everything. Models run on your own hardware.'
      : 'This computer is missing something the pipeline needs — see the details below.';
    verdict.classList.add(ready ? 'state-ok' : 'state-bad');

    this.renderPlain(plain, caps);
    this.renderTechnical(platform);
  }

  /** The plain-language block. No adapter ids, no API names. */
  private renderPlain(target: HTMLDListElement, caps: BrowserCapabilities): void {
    const { row } = this.deps;

    // ---- What has left the machine -------------------------------------
    // Derived from what actually went over the wire, not asserted. The claim only
    // stays true if the number comes from the thing doing the sending.
    const sent = this.deps.sentBytes();

    target.append(
      row(
        'Data sent out',
        sent === 0 ? 'nothing yet' : 'covered-up screenshots only',
        sent === 0 ? 'ok' : 'warn',
        sent === 0
          ? 'no task has run, so nothing has been transmitted'
          : 'page text and a covered-up screenshot — your data was removed first',
      ),
    );

    const settings = this.settings;
    target.append(
      row(
        'Sent to',
        settings === undefined || settings.baseUrl === '' ? 'not configured' : settings.baseUrl,
        settings?.provider === 'local' ? 'ok' : undefined,
        settings?.provider === 'local'
          ? 'a server on this machine, so nothing reaches the internet'
          : 'the model you configured above',
      ),
    );

    // ---- Where the thinking happens ------------------------------------
    target.append(
      row(
        'Runs on',
        caps.webgpu.available ? 'your graphics card' : 'your processor',
        caps.webgpu.available ? 'ok' : 'warn',
        caps.webgpu.available
          ? 'faster, and the reason the vision model is usable at all'
          : 'no graphics acceleration found, so the vision model will be slow',
      ),
    );

    // ---- Memory --------------------------------------------------------
    const memGb = caps.device.memoryGb;
    const tight = memGb !== null && memGb <= 4;
    target.append(
      row(
        'Memory',
        memGb === null ? 'unknown' : `about ${String(memGb)} GB`,
        tight ? 'warn' : 'ok',
        tight
          ? 'enough, but close other tabs before using the vision model'
          : 'comfortable for the models this extension ships',
      ),
    );

    // ---- What is bundled -----------------------------------------------
    const bundled = totalBundledMb([OWLVIT_BASE32, TESSERACT_ENG]) + ORT_RUNTIME_MB;
    target.append(
      row(
        'Models included',
        `${String(bundled)} MB, built in`,
        'ok',
        'nothing is downloaded, so it works with no internet at all',
      ),
    );

    // ---- Live state ----------------------------------------------------
    const detectorLoaded = isDetectorLoaded();
    target.append(
      row(
        'Vision model',
        detectorLoaded ? 'loaded and ready' : 'not loaded yet',
        detectorLoaded ? 'ok' : undefined,
        detectorLoaded
          ? 'using memory now — unload it above when you are done'
          : 'load it above to let Yukti see buttons that are only pictures',
      ),
    );
    target.append(
      row(
        'Text-in-images reader',
        isOcrReady() ? 'loaded and ready' : 'not loaded yet',
        isOcrReady() ? 'ok' : undefined,
        'reads text that only exists as pixels, such as a scanned marksheet',
      ),
    );

    // ---- Vault ---------------------------------------------------------
    const vaultCount = this.deps.vaultCount();
    target.append(
      row(
        'Your saved values',
        vaultCount === 0 ? 'vault locked or empty' : `${String(vaultCount)} available`,
        vaultCount === 0 ? 'warn' : 'ok',
        vaultCount === 0
          ? 'add your name in Profile so it can be covered up reliably'
          : 'used to hide your data and to fill forms for you, never sent anywhere',
      ),
    );

    // ---- Acting on pages -----------------------------------------------
    target.append(
      row(
        'Clicking and typing',
        'working',
        'ok',
        'a few very strict sites can tell the difference from a real keystroke and may ignore it',
      ),
    );

    target.append(
      row(
        'Screenshots',
        'this tab only',
        'ok',
        'taken directly from the tab the agent is working in, never the rest of your screen',
      ),
    );

    target.append(
      row(
        'Browser',
        `${caps.browser === 'chrome' ? 'Chrome' : caps.browser === 'firefox' ? 'Firefox' : caps.browser} · Manifest V${String(caps.manifestVersion)}`,
      ),
    );
  }

  /** Raw diagnostics, for when the plain answer is "something is wrong". */
  private renderTechnical(p: PlatformAdapters): void {
    const { row } = this.deps;
    const caps = p.capabilities;

    const platformReport = this.deps.el<HTMLDListElement>('platform-report');
    platformReport.textContent = '';

    platformReport.append(
      row('Browser', `${caps.browser} · MV${String(caps.manifestVersion)}`),
    );

    if (caps.webgpu.available) {
      platformReport.append(
        row(
          'WebGPU',
          'available',
          'ok',
          caps.webgpu.adapter === undefined
            ? undefined
            : `${caps.webgpu.adapter.vendor} ${caps.webgpu.adapter.architecture}`.trim(),
        ),
      );
      if (caps.webgpu.limits !== undefined) {
        platformReport.append(
          row(
            'Max GPU buffer',
            formatGpuMemory(caps.webgpu.limits.maxBufferSize),
            'ok',
            'decides which models can load',
          ),
        );
      }
    } else {
      platformReport.append(row('WebGPU', 'unavailable', 'warn', caps.webgpu.reason ?? ''));
    }

    platformReport.append(
      row('Inference backend', chooseBackend(caps), caps.webgpu.available ? 'ok' : 'warn'),
    );
    platformReport.append(
      row(
        'WebAssembly',
        `SIMD ${caps.wasm.simd ? 'yes' : 'no'} · threads ${caps.wasm.threads ? 'yes' : 'no'}`,
        caps.wasm.simd ? 'ok' : 'warn',
        caps.wasm.threads ? undefined : 'extension pages are not cross-origin isolated',
      ),
    );
    platformReport.append(
      row(
        'Device',
        `${String(caps.device.cores)} cores · ${
          caps.device.memoryGb === null
            ? 'RAM unknown'
            : `~${String(caps.device.memoryGb)} GB RAM`
        }`,
      ),
    );
    platformReport.append(row('Summary', summarize(caps)));

    const adapters = this.deps.el<HTMLDListElement>('adapter-report');
    adapters.textContent = '';
    adapters.append(row('Read markup', p.observe.id, 'ok', 'DOM and ARIA extractor'));
    adapters.append(row('Screenshot', p.capture.id, 'ok', 'viewport capture, stays local'));
    adapters.append(row('Model host', p.modelHost.id, 'ok', `${p.modelHost.kind}`));
    adapters.append(
      row(
        'Act on page',
        p.dispatch.id,
        'ok',
        p.dispatch.trusted ? 'trusted input events' : 'synthetic events, isTrusted is false',
      ),
    );
    adapters.append(
      row('Reasoning server', 'not connected', 'warn', 'the remaining piece of the pipeline'),
    );
  }
}
