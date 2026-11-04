import type { DatabaseSync } from 'node:sqlite';
import type { HistoryRange } from '../shared/contracts';
import type { MailAdapter } from '../ingestion/mail-adapter';
import { transaction } from '../storage/database';
import type { ProcessingStore } from '../storage/processing-store';
import type { SyncCursorStore } from '../storage/sync-cursor-store';

// Discovers mail for one account folder and records it as durable queued
// work (docs/ARCHITECTURE.md, "Incremental protocol and durable progress").
// Discovered refs are always persisted in the same transaction that advances
// the cursor or page token, so a crash never skips mail.

export interface IngestResult {
  mode: 'initial-scan' | 'incremental' | 'rescan';
  /** Messages newly added to the queue during this run. */
  discovered: number;
  /**
   * True when a change cursor expired and the configured range may not reach
   * back to the last successful sync, so some mail could have been missed.
   */
  possibleGap: boolean;
}

export interface IngestTarget {
  accountId: string;
  folder: string;
  adapter: MailAdapter;
  range: HistoryRange;
}

/** Earliest receipt time the configured range covers, or null for all history. */
export function rangeStart(range: HistoryRange, now: Date): Date | null {
  if (range.mode === 'all-history') return null;
  if (range.mode === 'last-30-days') return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [y, m, d] = (range.fromDate ?? '').split('-').map(Number);
  return new Date(y, m - 1, d);
}

export class Ingestion {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cursors: SyncCursorStore,
    private readonly queue: ProcessingStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async ingest({ accountId, folder, adapter, range }: IngestTarget): Promise<IngestResult> {
    const rangeKey = JSON.stringify(range);
    const state = this.cursors.get(accountId, folder);

    if (state?.initialScanDone && state.cursor && state.scanRange === rangeKey) {
      const changes = await adapter.listChanges(state.cursor);
      if (changes.status === 'ok') {
        const now = this.clock().toISOString();
        const discovered = transaction(this.db, () => {
          const added = this.queue.enqueue(changes.refs, now);
          this.cursors.advance(accountId, folder, changes.cursor, now);
          return added;
        });
        return { mode: 'incremental', discovered, possibleGap: false };
      }
      // Expired cursor: rescan the configured range. Existing queue entries
      // are kept, so already-known mail is not duplicated.
      const start = rangeStart(range, this.clock());
      const possibleGap = start !== null && (!state.lastSyncedAt || new Date(state.lastSyncedAt) < start);
      const discovered = await this.scan(accountId, folder, adapter, range, rangeKey, true);
      return { mode: 'rescan', discovered, possibleGap };
    }

    // No completed scan for this range: resume an interrupted one or start fresh.
    // A changed range (e.g. expanded history) also scans again.
    const resume = state !== null && !state.initialScanDone && state.scanRange === rangeKey && !!state.scanCursor;
    const discovered = await this.scan(accountId, folder, adapter, range, rangeKey, !resume);
    // A previously completed scan leaves a cursor behind, even while a rescan is in progress.
    return { mode: state?.cursor ? 'rescan' : 'initial-scan', discovered, possibleGap: false };
  }

  private async scan(
    accountId: string,
    folder: string,
    adapter: MailAdapter,
    range: HistoryRange,
    rangeKey: string,
    fresh: boolean,
  ): Promise<number> {
    if (fresh) {
      // Capture the change cursor before listing so mail arriving mid-scan is caught later.
      this.cursors.beginScan(accountId, folder, await adapter.currentCursor(), rangeKey);
    }
    let pageToken = this.cursors.get(accountId, folder)?.scanPageToken ?? null;
    let discovered = 0;
    do {
      const page = await adapter.listInitial(range, pageToken);
      const now = this.clock().toISOString();
      discovered += transaction(this.db, () => {
        const added = this.queue.enqueue(page.refs, now);
        if (page.nextPageToken) this.cursors.savePageToken(accountId, folder, page.nextPageToken);
        else this.cursors.completeScan(accountId, folder, now);
        return added;
      });
      pageToken = page.nextPageToken;
    } while (pageToken);
    return discovered;
  }
}
