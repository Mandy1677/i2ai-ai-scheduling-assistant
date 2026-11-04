import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { MessageRef } from '../ingestion/mail-adapter';

/**
 * Durable processing stages. Items are discovered as `queued`; later stages
 * are set by the pipeline. Terminal stages are never picked up again.
 */
export const Stage = {
  queued: 'queued',
  awaitingAnalysis: 'awaiting-analysis',
  analyzed: 'analyzed',
  failed: 'failed',
  sourceMissing: 'source-missing',
} as const;

export interface ProcessingItem extends MessageRef {
  id: string;
  stage: string;
  attempts: number;
  errorCode: string | null;
  fingerprint: string | null;
}

interface ItemRow {
  id: string;
  account_id: string;
  source_message_id: string;
  source_thread_id: string | null;
  received_at: string | null;
  stage: string;
  attempts: number;
  error_code: string | null;
  fingerprint: string | null;
}

const toItem = (row: ItemRow): ProcessingItem => ({
  id: row.id,
  accountId: row.account_id,
  providerMessageId: row.source_message_id,
  threadId: row.source_thread_id,
  receivedAt: row.received_at,
  stage: row.stage,
  attempts: row.attempts,
  errorCode: row.error_code,
  fingerprint: row.fingerprint,
});

/** Queue of messages to process, keyed by source reference. Never holds message content. */
export class ProcessingStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Adds refs not already known for their account; returns how many were new. */
  enqueue(refs: MessageRef[], now: string): number {
    const insert = this.db.prepare(
      `INSERT INTO processing_items
         (id, account_id, source_message_id, source_thread_id, received_at, stage, attempts, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(account_id, source_message_id) DO NOTHING`,
    );
    let added = 0;
    for (const ref of refs) {
      const result = insert.run(
        randomUUID(),
        ref.accountId,
        ref.providerMessageId,
        ref.threadId,
        ref.receivedAt,
        Stage.queued,
        now,
        now,
      );
      added += Number(result.changes);
    }
    return added;
  }

  /** Items in `stages` whose retry time has passed, oldest discovery first. */
  due(stages: string[], now: string, limit: number): ProcessingItem[] {
    const placeholders = stages.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM processing_items
         WHERE stage IN (${placeholders}) AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at, rowid LIMIT ?`,
      )
      .all(...stages, now, limit) as unknown as ItemRow[];
    return rows.map(toItem);
  }

  get(id: string): ProcessingItem | null {
    const row = this.db.prepare('SELECT * FROM processing_items WHERE id = ?').get(id) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  /** Records receipt details learned when the message was fetched. */
  updateSource(id: string, details: { threadId: string | null; receivedAt: string | null; fingerprint: string }): void {
    this.db
      .prepare(
        'UPDATE processing_items SET source_thread_id = ?, received_at = ?, fingerprint = ? WHERE id = ?',
      )
      .run(details.threadId, details.receivedAt, details.fingerprint, id);
  }

  setStage(id: string, stage: string, now: string): void {
    this.db
      .prepare(
        `UPDATE processing_items SET stage = ?, error_code = NULL, attempts = 0, next_attempt_at = NULL,
           updated_at = ? WHERE id = ?`,
      )
      .run(stage, now, id);
  }

  /** Records a failed attempt with a safe error code, scheduling a retry or giving up. */
  recordFailure(id: string, errorCode: string, retryAt: string | null, now: string): void {
    this.db
      .prepare(
        `UPDATE processing_items SET attempts = attempts + 1, error_code = ?, next_attempt_at = ?,
           stage = CASE WHEN ? IS NULL THEN '${Stage.failed}' ELSE stage END, updated_at = ? WHERE id = ?`,
      )
      .run(errorCode, retryAt, retryAt, now, id);
  }

  countByStage(accountId?: string): Record<string, number> {
    const rows = (
      accountId
        ? this.db
            .prepare('SELECT stage, COUNT(*) AS n FROM processing_items WHERE account_id = ? GROUP BY stage')
            .all(accountId)
        : this.db.prepare('SELECT stage, COUNT(*) AS n FROM processing_items GROUP BY stage').all()
    ) as { stage: string; n: number }[];
    return Object.fromEntries(rows.map((row) => [row.stage, row.n]));
  }
}
