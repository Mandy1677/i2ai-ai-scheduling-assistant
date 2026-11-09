import type { SyncRequestResult } from '../shared/contracts';

/** One run of the pipeline; it checks `shouldStop` between steps so Exit is not held up. */
export type SyncRun = (shouldStop: () => boolean) => Promise<void>;

/** Background check interval while the App runs (docs/ARCHITECTURE.md section 6). */
export const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Single entry point for background and manual synchronization.
 * Guarantees at most one active run.
 */
export class SyncCoordinator {
  private running: Promise<void> | null = null;
  private stopping = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly isConfigured: () => boolean,
    private readonly run: SyncRun,
    private readonly onRunError: (error: unknown) => void,
    private readonly onStateChange: (running: boolean) => void = () => undefined,
  ) {}

  get isRunning(): boolean {
    return this.running !== null;
  }

  requestSync(): SyncRequestResult {
    if (this.running || this.stopping) return { status: 'already-running' };
    if (!this.isConfigured()) return { status: 'configuration-required' };

    this.onStateChange(true);
    this.running = this.run(() => this.stopping)
      .catch(this.onRunError)
      .finally(() => {
        this.running = null;
        this.onStateChange(false);
      });
    return { status: 'started' };
  }

  /** Requests a run every `intervalMs`; a tick during an active run is skipped. */
  schedule(intervalMs: number = SYNC_INTERVAL_MS): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.requestSync(), intervalMs);
  }

  /** Stops scheduling and asks an active run to finish early. Queued work stays durable. */
  stop(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Waits for an active run so Exit can stop after persisting work. */
  async whenIdle(): Promise<void> {
    await this.running;
  }
}
