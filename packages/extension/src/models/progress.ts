/**
 * Model load progress.
 *
 * The weights are bundled, so nothing is downloaded — but reading 182 MiB off
 * disk and compiling the graph is still several seconds of silence, and a silent
 * extension looks broken. So progress is surfaced per file with a real byte
 * count.
 *
 * Transformers.js emits a loosely-typed stream of progress events; this narrows
 * them into something the UI can render without guessing.
 */

export type LoadPhase = 'idle' | 'resolving' | 'reading' | 'loading' | 'ready' | 'failed';

export interface FileProgress {
  readonly file: string;
  readonly loaded: number;
  readonly total: number;
  /** 0..1, or null when the server sent no content length. */
  readonly fraction: number | null;
}

export interface LoadProgress {
  readonly modelKey: string;
  readonly phase: LoadPhase;
  readonly files: readonly FileProgress[];
  readonly loadedBytes: number;
  readonly totalBytes: number;
  /** 0..1 across all known files, or null when totals are unknown. */
  readonly fraction: number | null;
  readonly message: string;
  readonly error?: string;
}

/** The subset of the transformers.js progress event we rely on. */
interface RawProgress {
  status?: string;
  file?: string;
  name?: string;
  loaded?: number;
  total?: number;
  progress?: number;
}

function isRawProgress(value: unknown): value is RawProgress {
  return typeof value === 'object' && value !== null;
}

/**
 * Accumulates per-file progress into one report.
 *
 * Stateful because the underlying events are per-file and interleaved: a naive
 * pass-through would make the bar jump backwards as files alternate.
 */
export class ProgressTracker {
  private readonly files = new Map<string, FileProgress>();
  private phase: LoadPhase = 'idle';
  private message = '';
  private error: string | undefined;

  constructor(
    private readonly modelKey: string,
    private readonly onUpdate: (progress: LoadProgress) => void,
  ) {}

  /** Callback shaped for `pipeline({ progress_callback })`. */
  readonly handle = (raw: unknown): void => {
    if (!isRawProgress(raw)) return;

    const status = raw.status ?? '';
    const file = raw.file ?? raw.name ?? 'model';

    switch (status) {
      case 'initiate':
        this.phase = 'resolving';
        this.message = `Resolving ${file}`;
        this.files.set(file, { file, loaded: 0, total: raw.total ?? 0, fraction: null });
        break;

      case 'download':
        this.phase = 'reading';
        this.message = `Reading ${file}`;
        break;

      case 'progress': {
        this.phase = 'reading';
        const loaded = raw.loaded ?? 0;
        const total = raw.total ?? 0;
        this.files.set(file, {
          file,
          loaded,
          total,
          fraction: total > 0 ? Math.min(1, loaded / total) : null,
        });
        this.message = `Reading ${file}`;
        break;
      }

      case 'done': {
        const existing = this.files.get(file);
        if (existing !== undefined) {
          this.files.set(file, { ...existing, loaded: existing.total, fraction: 1 });
        }
        this.message = `Loaded ${file}`;
        break;
      }

      case 'ready':
        this.phase = 'ready';
        this.message = 'Ready';
        break;

      default:
        break;
    }

    this.emit();
  };

  /** Weights are cached; the remaining cost is graph construction. */
  markCompiling(): void {
    this.phase = 'loading';
    this.message = 'Compiling model graph';
    this.emit();
  }

  markReady(): void {
    this.phase = 'ready';
    this.message = 'Ready';
    this.emit();
  }

  markFailed(error: unknown): void {
    this.phase = 'failed';
    this.error = error instanceof Error ? error.message : String(error);
    this.message = 'Failed';
    this.emit();
  }

  snapshot(): LoadProgress {
    const files = [...this.files.values()];
    let loadedBytes = 0;
    let totalBytes = 0;
    for (const f of files) {
      loadedBytes += f.loaded;
      totalBytes += f.total;
    }
    return {
      modelKey: this.modelKey,
      phase: this.phase,
      files,
      loadedBytes,
      totalBytes,
      fraction: totalBytes > 0 ? Math.min(1, loadedBytes / totalBytes) : null,
      message: this.message,
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  private emit(): void {
    this.onUpdate(this.snapshot());
  }
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${String(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(2)} GB`;
}
