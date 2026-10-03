/**
 * Detector card.
 *
 * Owns the visible lifecycle of the local vision model: pick one, see its real
 * cost, load it, unload it to reclaim memory. Nothing else — running the model is
 * the Audit tab's job, because what the model sees only matters in the context of
 * what would be sent.
 *
 * Making the cost visible is deliberate rather than decorative. Resident memory is
 * a fifth of this project's score, and on a 4 GB machine the difference between one
 * model and three is the difference between working and thrashing. A user who can
 * see that is a user who can make the right call.
 */

import type { BrowserCapabilities } from '@sih/core';
import {
  assessFit,
  detectorSpecs,
  modelByKey,
  OWLVIT_BASE32,
  TESSERACT_ENG,
  totalResidentMb,
  type ModelSpec,
} from '../../models/catalogue.ts';
import { formatBytes, type LoadProgress } from '../../models/progress.ts';
import { disposeDetector, isDetectorLoaded, loadDetector } from '../../models/vision.ts';
import { disposeOcrWorker } from '../../models/ocr.ts';

type State = 'ok' | 'warn' | 'bad';

export interface DetectorCardDeps {
  readonly el: <T extends HTMLElement>(id: string) => T;
  readonly row: (term: string, value: string, state?: State, note?: string) => DocumentFragment;
  readonly say: (message: string, state?: State) => void;
  /** Called when the model becomes available or is released. */
  readonly onChanged?: () => void;
}

export class DetectorCard {
  private selected: ModelSpec = OWLVIT_BASE32;

  constructor(private readonly deps: DetectorCardDeps) {}

  init(capabilities: BrowserCapabilities): void {
    const select = this.deps.el<HTMLSelectElement>('model-select');
    select.textContent = '';

    for (const spec of detectorSpecs()) {
      const option = document.createElement('option');
      option.value = spec.key;
      option.textContent = `${spec.repo} · ${spec.quantization} · ${String(spec.bundledMb)} MiB`;
      select.appendChild(option);
    }
    select.value = this.selected.key;

    select.addEventListener('change', () => {
      const spec = modelByKey(select.value);
      if (spec !== undefined) {
        this.selected = spec;
        this.renderInfo(capabilities);
        this.renderFitWarning(capabilities);
      }
    });

    this.deps.el<HTMLButtonElement>('load-model').addEventListener('click', () => {
      void this.load(capabilities);
    });
    this.deps.el<HTMLButtonElement>('unload-model').addEventListener('click', () => {
      void this.unload();
    });

    this.renderInfo(capabilities);
    this.renderFitWarning(capabilities);
  }

  /**
   * One line: is it loaded, and how big is it.
   *
   * This used to be six rows covering licence, disk layout, chunk counts, resident
   * memory and which processor it runs on. All true, none of it what somebody opens
   * this panel to find out.
   */
  private renderInfo(_capabilities: BrowserCapabilities): void {
    const target = this.deps.el<HTMLDListElement>('model-info');
    target.textContent = '';
    target.append(
      this.deps.row(
        'Status',
        isDetectorLoaded() ? 'loaded' : 'not loaded',
        isDetectorLoaded() ? 'ok' : undefined,
        `${String(this.selected.bundledMb)} MiB, bundled — nothing is downloaded`,
      ),
    );
  }

  private renderFitWarning(capabilities: BrowserCapabilities): void {
    const node = this.deps.el<HTMLDivElement>('fit-warning');
    const stack = [this.selected, TESSERACT_ENG];
    const fit = assessFit(stack, capabilities.device.memoryGb);
    const ram = capabilities.device.memoryGb;

    node.classList.remove('state-warn', 'state-bad');

    if (fit === 'comfortable') {
      node.hidden = true;
      return;
    }

    node.hidden = false;
    node.classList.add(fit === 'tight' ? 'state-warn' : 'state-bad');
    node.textContent =
      fit === 'tight'
        ? `This machine reports about ${String(ram)} GB of memory. The detector plus the text ` +
          `reader needs around ${String(totalResidentMb(stack))} MB, which works but leaves ` +
          `little headroom. Close other tabs first.`
        : `This machine reports about ${String(ram)} GB of memory, below what this stack needs ` +
          `(~${String(totalResidentMb(stack))} MB). Loading may fail or make the browser ` +
          `unresponsive.`;
  }

  private setProgress(progress: LoadProgress): void {
    this.deps.el<HTMLDivElement>('progress-wrap').hidden = false;
    const bar = this.deps.el<HTMLDivElement>('progress-bar');
    const text = this.deps.el<HTMLParagraphElement>('progress-text');

    const pct = progress.fraction === null ? null : Math.round(progress.fraction * 100);
    bar.style.width = pct === null ? '100%' : `${String(pct)}%`;

    const bytes =
      progress.totalBytes > 0
        ? ` ${formatBytes(progress.loadedBytes)} / ${formatBytes(progress.totalBytes)}`
        : '';
    text.textContent =
      progress.error === undefined
        ? `${progress.message}${bytes}${pct === null ? '' : ` · ${String(pct)}%`}`
        : `Failed: ${progress.error}`;
  }

  private async load(capabilities: BrowserCapabilities): Promise<void> {
    const loadBtn = this.deps.el<HTMLButtonElement>('load-model');
    loadBtn.disabled = true;

    this.deps.say(
      `Loading the detector (${String(this.selected.bundledMb)} MiB) from inside the ` +
        'extension. Nothing is downloaded.',
    );

    try {
      await loadDetector({
        capabilities,
        spec: this.selected,
        onProgress: (p) => {
          this.setProgress(p);
        },
      });
      this.deps.el<HTMLButtonElement>('unload-model').disabled = false;
      this.deps.say('Detector ready. Yukti can now see buttons that are only pictures.', 'ok');
      this.deps.onChanged?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.deps.say(`Could not load the detector: ${message}`, 'bad');
      this.setProgress({
        modelKey: this.selected.key,
        phase: 'failed',
        files: [],
        loadedBytes: 0,
        totalBytes: 0,
        fraction: null,
        message: 'Failed',
        error: message,
      });
    } finally {
      loadBtn.disabled = false;
    }
  }

  private async unload(): Promise<void> {
    await Promise.all([disposeDetector(), disposeOcrWorker()]);
    this.deps.el<HTMLButtonElement>('unload-model').disabled = true;
    this.deps.el<HTMLDivElement>('progress-wrap').hidden = true;
    this.deps.say('Detector unloaded, memory released.', 'ok');
    this.deps.onChanged?.();
  }

  ready(): boolean {
    return isDetectorLoaded();
  }
}
