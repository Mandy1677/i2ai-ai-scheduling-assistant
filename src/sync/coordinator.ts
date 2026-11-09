import type { SyncRequestResult } from '../shared/contracts';

export type SyncRun = () => Promise<void>;

/**
 * Single entry point for background and manual synchronization.
 * Guarantees at most one active run; the pipeline itself arrives with T016.
 */
export class SyncCoordinator {
  private running: Promise<void> | null = null;

  constructor(
    private readonly isConfigured: () => boolean,
    private readonly run: SyncRun,
    private readonly onRunError: (error: unknown) => void,
  ) {}

  get isRunning(): boolean {
    return this.running !== null;
  }

  requestSync(): SyncRequestResult {
    if (this.running) return { status: 'already-running' };
    if (!this.isConfigured()) return { status: 'configuration-required' };

    this.running = this.run()
      .catch(this.onRunError)
      .finally(() => {
        this.running = null;
      });
    return { status: 'started' };
  }

  /** Waits for an active run so Exit can stop after persisting work. */
  async whenIdle(): Promise<void> {
    await this.running;
  }
}
