import type { DatabaseSync } from 'node:sqlite';

/** Reading progress for one account folder (docs/ARCHITECTURE.md section 5, "Sync cursor"). */
export interface SyncCursor {
  accountId: string;
  folder: string;
  /** Provider change cursor; valid once the initial scan has completed. */
  cursor: string | null;
  initialScanDone: boolean;
  /** Cursor captured when the current scan started, so mail arriving mid-scan is not missed. */
  scanCursor: string | null;
  /** Provider page token to resume an interrupted scan. */
  scanPageToken: string | null;
  /** JSON of the history range the current or last scan covered. */
  scanRange: string | null;
  lastSyncedAt: string | null;
}

interface CursorRow {
  account_id: string;
  folder: string;
  cursor: string | null;
  initial_scan_done: number;
  scan_cursor: string | null;
  scan_page_token: string | null;
  scan_range_json: string | null;
  last_synced_at: string | null;
}

export class SyncCursorStore {
  constructor(private readonly db: DatabaseSync) {}

  get(accountId: string, folder: string): SyncCursor | null {
    const row = this.db
      .prepare('SELECT * FROM sync_cursors WHERE account_id = ? AND folder = ?')
      .get(accountId, folder) as CursorRow | undefined;
    if (!row) return null;
    return {
      accountId: row.account_id,
      folder: row.folder,
      cursor: row.cursor,
      initialScanDone: row.initial_scan_done === 1,
      scanCursor: row.scan_cursor,
      scanPageToken: row.scan_page_token,
      scanRange: row.scan_range_json,
      lastSyncedAt: row.last_synced_at,
    };
  }

  /** Starts (or restarts) a scan of `scanRange`, keeping any completed cursor until it finishes. */
  beginScan(accountId: string, folder: string, scanCursor: string, scanRange: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_cursors (account_id, folder, initial_scan_done, scan_cursor, scan_page_token, scan_range_json)
         VALUES (?, ?, 0, ?, NULL, ?)
         ON CONFLICT(account_id, folder) DO UPDATE SET
           initial_scan_done = 0, scan_cursor = excluded.scan_cursor,
           scan_page_token = NULL, scan_range_json = excluded.scan_range_json`,
      )
      .run(accountId, folder, scanCursor, scanRange);
  }

  savePageToken(accountId: string, folder: string, pageToken: string | null): void {
    this.db
      .prepare('UPDATE sync_cursors SET scan_page_token = ? WHERE account_id = ? AND folder = ?')
      .run(pageToken, accountId, folder);
  }

  /** Marks the scan complete; its starting cursor becomes the change cursor. */
  completeScan(accountId: string, folder: string, syncedAt: string): void {
    this.db
      .prepare(
        `UPDATE sync_cursors SET cursor = scan_cursor, initial_scan_done = 1, scan_cursor = NULL,
           scan_page_token = NULL, last_synced_at = ? WHERE account_id = ? AND folder = ?`,
      )
      .run(syncedAt, accountId, folder);
  }

  advance(accountId: string, folder: string, cursor: string, syncedAt: string): void {
    this.db
      .prepare('UPDATE sync_cursors SET cursor = ?, last_synced_at = ? WHERE account_id = ? AND folder = ?')
      .run(cursor, syncedAt, accountId, folder);
  }
}
