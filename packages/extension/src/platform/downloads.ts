/**
 * Browser-local download completion tracking.
 *
 * Filenames and source URLs never enter agent history or model messages. The tracker
 * exposes only a generic state transition so the local controller can verify that a
 * requested download actually completed before accepting task success.
 */

type DownloadItem = { readonly id: number; readonly state?: string };
type DownloadDelta = {
  readonly id: number;
  readonly state?: { readonly current?: string };
  readonly error?: { readonly current?: string };
};

type Event<T> = {
  addListener(listener: (value: T) => void): void;
  removeListener(listener: (value: T) => void): void;
};

type DownloadsApi = {
  readonly onCreated: Event<DownloadItem>;
  readonly onChanged: Event<DownloadDelta>;
};

function downloadsApi(): DownloadsApi | undefined {
  const globals = globalThis as {
    chrome?: { downloads?: DownloadsApi };
    browser?: { downloads?: DownloadsApi };
  };
  return globals.chrome?.downloads ?? globals.browser?.downloads;
}

export type DownloadOutcome = 'none' | 'complete' | 'failed';

export class DownloadTracker {
  private readonly states = new Map<number, 'pending' | 'complete' | 'failed'>();
  private createdVersion = 0;
  private changedVersion = 0;

  private readonly onCreated = (item: DownloadItem): void => {
    this.states.set(item.id, item.state === 'complete' ? 'complete' : 'pending');
    this.createdVersion++;
    this.changedVersion++;
  };

  private readonly onChanged = (delta: DownloadDelta): void => {
    if (!this.states.has(delta.id)) return;
    if (delta.error?.current !== undefined || delta.state?.current === 'interrupted') {
      this.states.set(delta.id, 'failed');
    } else if (delta.state?.current === 'complete') {
      this.states.set(delta.id, 'complete');
    }
    this.changedVersion++;
  };

  private constructor(private readonly api: DownloadsApi) {
    api.onCreated.addListener(this.onCreated);
    api.onChanged.addListener(this.onChanged);
  }

  static create(): DownloadTracker | undefined {
    const api = downloadsApi();
    return api === undefined ? undefined : new DownloadTracker(api);
  }

  private async waitForChange(version: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.changedVersion !== version) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    return this.changedVersion !== version;
  }

  /** Wait briefly for creation, then until that local download completes or fails. */
  async waitForActivity(discoveryMs = 3_000, completionMs = 60_000): Promise<DownloadOutcome> {
    const initialCreated = this.createdVersion;
    let observed = this.states.size > 0;
    if (!observed) {
      const changed = await this.waitForChange(this.changedVersion, discoveryMs);
      observed = changed && this.createdVersion !== initialCreated;
    }
    if (!observed) return 'none';

    const deadline = Date.now() + completionMs;
    while (Date.now() < deadline) {
      if ([...this.states.values()].some((state) => state === 'complete')) return 'complete';
      if ([...this.states.values()].some((state) => state === 'failed')) return 'failed';
      const version = this.changedVersion;
      await this.waitForChange(version, Math.min(1_000, Math.max(0, deadline - Date.now())));
    }
    return 'failed';
  }

  dispose(): void {
    this.api.onCreated.removeListener(this.onCreated);
    this.api.onChanged.removeListener(this.onChanged);
    this.states.clear();
  }
}
