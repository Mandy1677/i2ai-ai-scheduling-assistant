import type { DatabaseSync } from 'node:sqlite';

// Records from docs/ARCHITECTURE.md section 5. Append new steps; never edit a
// shipped one. No table stores email bodies.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE secrets (
    id TEXT PRIMARY KEY,
    ciphertext BLOB NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL UNIQUE COLLATE NOCASE,
    provider TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    folder_scope TEXT NOT NULL DEFAULT 'INBOX',
    credential_secret_id TEXT REFERENCES secrets(id),
    connection_state TEXT NOT NULL DEFAULT 'not-connected',
    created_at TEXT NOT NULL
  );

  CREATE TABLE sync_cursors (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder TEXT NOT NULL,
    cursor TEXT,
    initial_scan_done INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, folder)
  );

  CREATE TABLE processing_items (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    source_message_id TEXT NOT NULL,
    source_thread_id TEXT,
    received_at TEXT,
    fingerprint TEXT,
    stage TEXT NOT NULL,
    error_code TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, source_message_id)
  );

  CREATE TABLE scheduling_items (
    id TEXT PRIMARY KEY,
    request_type TEXT NOT NULL,
    category TEXT,
    summary TEXT NOT NULL,
    timing_json TEXT,
    urgency_json TEXT,
    confirmation_state TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE scheduling_item_sources (
    scheduling_item_id TEXT NOT NULL REFERENCES scheduling_items(id) ON DELETE CASCADE,
    processing_item_id TEXT NOT NULL REFERENCES processing_items(id) ON DELETE CASCADE,
    PRIMARY KEY (scheduling_item_id, processing_item_id)
  );

  CREATE TABLE calendar_associations (
    scheduling_item_id TEXT PRIMARY KEY REFERENCES scheduling_items(id),
    calendar_id TEXT NOT NULL,
    event_id TEXT,
    kind TEXT NOT NULL,
    applied_fingerprint TEXT,
    last_known_etag TEXT,
    updated_at TEXT NOT NULL
  );
  `,
  // T007: resumable initial scans, last successful sync, and retry scheduling.
  `
  ALTER TABLE sync_cursors ADD COLUMN scan_cursor TEXT;
  ALTER TABLE sync_cursors ADD COLUMN scan_page_token TEXT;
  ALTER TABLE sync_cursors ADD COLUMN scan_range_json TEXT;
  ALTER TABLE sync_cursors ADD COLUMN last_synced_at TEXT;
  ALTER TABLE processing_items ADD COLUMN next_attempt_at TEXT;
  ALTER TABLE processing_items ADD COLUMN created_at TEXT;
  CREATE INDEX processing_items_due ON processing_items (stage, next_attempt_at);
  `,
  // T009/T010: validated analysis results and local ordering fields.
  `
  ALTER TABLE scheduling_items ADD COLUMN existing_meeting_ref TEXT;
  ALTER TABLE scheduling_items ADD COLUMN evidence_json TEXT;
  ALTER TABLE scheduling_items ADD COLUMN review_notes_json TEXT;
  ALTER TABLE scheduling_items ADD COLUMN prompt_version TEXT;
  ALTER TABLE scheduling_items ADD COLUMN analysis_model TEXT;
  ALTER TABLE scheduling_items ADD COLUMN redaction_failed INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE scheduling_items ADD COLUMN received_at TEXT;
  ALTER TABLE scheduling_items ADD COLUMN priority_rank INTEGER;
  ALTER TABLE scheduling_items ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE scheduling_items ADD COLUMN deadline TEXT;
  ALTER TABLE scheduling_items ADD COLUMN created_at TEXT;
  `,
  // T011-T013: local alias table for calendar titles, and calendar entry state.
  `
  ALTER TABLE scheduling_items ADD COLUMN alias_json TEXT;
  ALTER TABLE calendar_associations ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE calendar_associations ADD COLUMN event_date TEXT;
  CREATE INDEX calendar_associations_event ON calendar_associations (calendar_id, event_id);
  `,
];

export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export const SCHEMA_VERSION = MIGRATIONS.length;
