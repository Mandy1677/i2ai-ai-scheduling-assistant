import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { HttpError } from '../ingestion/http';
import type {
  ChangesResult,
  InitialScanPage,
  MailAdapter,
  MessageRef,
  NormalizedMessage,
} from '../ingestion/mail-adapter';
import type { HistoryRange } from '../shared/contracts';
import { AccountStore } from '../storage/account-store';
import { openDatabase } from '../storage/database';
import { ProcessingStore, Stage } from '../storage/processing-store';
import { SyncCursorStore } from '../storage/sync-cursor-store';
import { Ingestion, rangeStart } from './ingestion';
import { awaitAnalysis, MAX_ATTEMPTS, processQueue, retryDelayMs } from './queue-worker';

const ALL: HistoryRange = { mode: 'all-history', fromDate: null };
const LAST_30: HistoryRange = { mode: 'last-30-days', fromDate: null };

/** In-memory mailbox implementing the adapter contract. */
class FakeMailbox implements MailAdapter {
  messages: { id: string; ageDays: number }[] = [];
  history = 100;
  added: string[] = [];
  pageSize = 2;
  failOnPage: number | null = null;
  expired = false;
  bodies = new Map<string, string>();
  fetchFailures = new Map<string, Error>();

  constructor(private readonly accountId: string) {}

  ref(id: string): MessageRef {
    return { accountId: this.accountId, providerMessageId: id, threadId: `t-${id}`, receivedAt: null };
  }

  deliver(id: string, ageDays = 0): void {
    this.messages.unshift({ id, ageDays });
    this.added.push(id);
    this.history++;
  }

  async currentCursor(): Promise<string> {
    return String(this.history);
  }

  async listInitial(range: HistoryRange, pageToken: string | null): Promise<InitialScanPage> {
    const inRange = this.messages.filter((m) => range.mode === 'all-history' || m.ageDays <= 30);
    const page = pageToken ? Number(pageToken) : 0;
    if (this.failOnPage === page) throw new Error('network down');
    const slice = inRange.slice(page * this.pageSize, (page + 1) * this.pageSize);
    const more = (page + 1) * this.pageSize < inRange.length;
    return { refs: slice.map((m) => this.ref(m.id)), nextPageToken: more ? String(page + 1) : null };
  }

  async listChanges(cursor: string): Promise<ChangesResult> {
    if (this.expired) return { status: 'cursor-expired' };
    const since = this.added.slice(Number(cursor) - 100);
    return { status: 'ok', refs: since.map((id) => this.ref(id)), cursor: String(this.history) };
  }

  async fetchMessage(ref: MessageRef): Promise<NormalizedMessage> {
    const failure = this.fetchFailures.get(ref.providerMessageId);
    if (failure) throw failure;
    return {
      ...ref,
      receivedAt: '2026-11-01T10:00:00.000Z',
      from: 'sender@example.com',
      to: ['me@example.com'],
      cc: [],
      subject: `Subject ${ref.providerMessageId}`,
      internetMessageId: `<${ref.providerMessageId}@example.com>`,
      bodyText: this.bodies.get(ref.providerMessageId) ?? `private body of ${ref.providerMessageId}`,
    };
  }
}

function setup() {
  const db = openDatabase(':memory:');
  const accountId = new AccountStore(db).add({
    address: 'test@example.com',
    provider: 'gmail',
    imap: null,
    credentialSecretId: null,
  });
  let now = new Date('2026-11-04T12:00:00Z');
  const clock = () => now;
  const cursors = new SyncCursorStore(db);
  const queue = new ProcessingStore(db);
  const ingestion = new Ingestion(db, cursors, queue, clock);
  const mailbox = new FakeMailbox(accountId);
  const target = (range: HistoryRange = ALL) => ({ accountId, folder: 'INBOX', adapter: mailbox, range });
  const setNow = (iso: string) => (now = new Date(iso));
  return { db, accountId, cursors, queue, ingestion, mailbox, target, clock, setNow };
}

const queuedIds = (db: DatabaseSync): string[] =>
  (db.prepare('SELECT source_message_id AS id FROM processing_items ORDER BY source_message_id').all() as {
    id: string;
  }[]).map((r) => r.id);

describe('ingestion', () => {
  test('initial scan queues every message across pages and captures the cursor first', async () => {
    const { db, ingestion, mailbox, cursors, accountId, target } = setup();
    ['m1', 'm2', 'm3', 'm4', 'm5'].forEach((id) => mailbox.deliver(id));
    const cursorBefore = await mailbox.currentCursor();
    const result = await ingestion.ingest(target());
    assert.deepEqual(result, { mode: 'initial-scan', discovered: 5, possibleGap: false });
    assert.deepEqual(queuedIds(db), ['m1', 'm2', 'm3', 'm4', 'm5']);
    const state = cursors.get(accountId, 'INBOX')!;
    assert.equal(state.initialScanDone, true);
    assert.equal(state.cursor, cursorBefore);
    assert.equal(state.scanPageToken, null);
  });

  test('an interrupted scan resumes from its saved page without duplicates', async () => {
    const { db, ingestion, mailbox, cursors, accountId, target } = setup();
    ['m1', 'm2', 'm3', 'm4', 'm5'].forEach((id) => mailbox.deliver(id));
    mailbox.failOnPage = 1;
    await assert.rejects(ingestion.ingest(target()), /network down/);
    assert.equal(queuedIds(db).length, 2, 'first page is persisted');
    assert.equal(cursors.get(accountId, 'INBOX')!.scanPageToken, '1');

    mailbox.failOnPage = null;
    const result = await ingestion.ingest(target());
    assert.equal(result.mode, 'initial-scan');
    assert.equal(result.discovered, 3);
    assert.equal(queuedIds(db).length, 5);
  });

  test('incremental runs queue only new mail, and repeats add nothing', async () => {
    const { db, ingestion, mailbox, target } = setup();
    mailbox.deliver('m1');
    await ingestion.ingest(target());
    mailbox.deliver('m2');
    mailbox.deliver('m3');
    assert.deepEqual(await ingestion.ingest(target()), { mode: 'incremental', discovered: 2, possibleGap: false });
    assert.deepEqual(await ingestion.ingest(target()), { mode: 'incremental', discovered: 0, possibleGap: false });
    assert.deepEqual(queuedIds(db), ['m1', 'm2', 'm3']);
  });

  test('mail arriving during the initial scan is picked up by the next run', async () => {
    const { db, ingestion, mailbox, target } = setup();
    ['m1', 'm2', 'm3'].forEach((id) => mailbox.deliver(id));
    const original = mailbox.listInitial.bind(mailbox);
    let delivered = false;
    mailbox.listInitial = async (range, token) => {
      const page = await original(range, token);
      if (!delivered) {
        delivered = true;
        mailbox.deliver('late'); // arrives after the scan captured its cursor
      }
      return page;
    };
    await ingestion.ingest(target());
    await ingestion.ingest(target());
    assert.ok(queuedIds(db).includes('late'));
  });

  test('an expired cursor triggers a rescan that keeps existing items', async () => {
    const { db, ingestion, mailbox, target } = setup();
    ['m1', 'm2'].forEach((id) => mailbox.deliver(id));
    await ingestion.ingest(target());
    mailbox.deliver('m3');
    mailbox.expired = true;
    const result = await ingestion.ingest(target());
    assert.deepEqual(result, { mode: 'rescan', discovered: 1, possibleGap: false });
    assert.deepEqual(queuedIds(db), ['m1', 'm2', 'm3']);
  });

  test('flags a possible gap when the range no longer reaches the last sync', async () => {
    const { ingestion, mailbox, target, setNow } = setup();
    mailbox.deliver('m1');
    await ingestion.ingest(target(LAST_30));
    setNow('2027-01-20T12:00:00Z'); // 77 days later
    mailbox.expired = true;
    const result = await ingestion.ingest(target(LAST_30));
    assert.equal(result.mode, 'rescan');
    assert.equal(result.possibleGap, true);
  });

  test('expanding the history range rescans and adds older mail only once', async () => {
    const { db, ingestion, mailbox, target } = setup();
    mailbox.deliver('old', 90);
    mailbox.deliver('recent', 1);
    await ingestion.ingest(target(LAST_30));
    assert.deepEqual(queuedIds(db), ['recent']);
    const result = await ingestion.ingest(target(ALL));
    assert.equal(result.mode, 'rescan');
    assert.equal(result.discovered, 1);
    assert.deepEqual(queuedIds(db), ['old', 'recent']);
  });

  test('range start follows the configured range', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    assert.equal(rangeStart(ALL, now), null);
    assert.equal(rangeStart(LAST_30, now)!.toISOString(), '2026-10-05T12:00:00.000Z');
    assert.equal(rangeStart({ mode: 'from-date', fromDate: '2026-10-01' }, now)!.getDate(), 1);
  });
});

describe('queue worker', () => {
  test('fetches by reference, records metadata, and never stores the body', async () => {
    const { db, ingestion, mailbox, queue, target, clock } = setup();
    ['m1', 'm2'].forEach((id) => mailbox.deliver(id));
    await ingestion.ingest(target());
    const result = await processQueue({ queue, adapterFor: () => mailbox, handler: awaitAnalysis, clock });
    assert.deepEqual(result, { processed: 2, retrying: 0, failed: 0, sourceMissing: 0 });
    assert.deepEqual(queue.countByStage(), { [Stage.awaitingAnalysis]: 2 });
    const rows = db.prepare('SELECT * FROM processing_items').all() as Record<string, unknown>[];
    assert.equal(rows[0].received_at, '2026-11-01T10:00:00.000Z');
    assert.match(String(rows[0].fingerprint), /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(rows).includes('private body'), 'no body text in the database');
  });

  test('a crash inside the handler leaves the item queued for retry after restart', async () => {
    const { ingestion, mailbox, queue, target, clock, setNow } = setup();
    mailbox.deliver('m1');
    await ingestion.ingest(target());
    const crash = await processQueue({
      queue,
      adapterFor: () => mailbox,
      handler: async () => {
        throw new Error('analysis crashed');
      },
      clock,
    });
    assert.equal(crash.retrying, 1);
    const item = queue.due([Stage.queued], '9999-01-01', 10)[0];
    assert.equal(item.stage, Stage.queued);
    assert.equal(item.errorCode, 'processing_failed');

    // Not due before its retry time…
    const early = await processQueue({ queue, adapterFor: () => mailbox, handler: awaitAnalysis, clock });
    assert.equal(early.processed, 0);
    // …and processed once it is.
    setNow(new Date(clock().getTime() + retryDelayMs(1)).toISOString());
    const later = await processQueue({ queue, adapterFor: () => mailbox, handler: awaitAnalysis, clock });
    assert.equal(later.processed, 1);
    assert.deepEqual(queue.countByStage(), { [Stage.awaitingAnalysis]: 1 });
  });

  test('gives up after repeated failures with a safe error code', async () => {
    const { ingestion, mailbox, queue, target, clock, setNow } = setup();
    mailbox.deliver('m1');
    await ingestion.ingest(target());
    mailbox.fetchFailures.set('m1', new HttpError(503, 'https://gmail.googleapis.com/x'));
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await processQueue({ queue, adapterFor: () => mailbox, handler: awaitAnalysis, clock });
      setNow(new Date(clock().getTime() + 7 * 60 * 60_000).toISOString());
    }
    assert.deepEqual(queue.countByStage(), { [Stage.failed]: 1 });
    const [row] = queue.due([Stage.failed], '9999-01-01', 1);
    assert.equal(row.errorCode, 'http_503');
  });

  test('a deleted source message is marked missing, not retried', async () => {
    const { ingestion, mailbox, queue, target, clock } = setup();
    mailbox.deliver('m1');
    await ingestion.ingest(target());
    mailbox.fetchFailures.set('m1', new HttpError(404, 'https://gmail.googleapis.com/x'));
    const result = await processQueue({ queue, adapterFor: () => mailbox, handler: awaitAnalysis, clock });
    assert.equal(result.sourceMissing, 1);
    assert.deepEqual(queue.countByStage(), { [Stage.sourceMissing]: 1 });
  });

  test('leaves work queued when the account adapter is unavailable', async () => {
    const { ingestion, mailbox, queue, target, clock } = setup();
    mailbox.deliver('m1');
    await ingestion.ingest(target());
    const result = await processQueue({ queue, adapterFor: () => null, handler: awaitAnalysis, clock });
    assert.equal(result.processed, 0);
    assert.deepEqual(queue.countByStage(), { [Stage.queued]: 1 });
  });

  test('progress survives closing and reopening the database', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'assistant-sync-test-'));
    try {
      const file = path.join(dir, 'assistant.sqlite');
      let db = openDatabase(file);
      const accountId = new AccountStore(db).add({
        address: 'a@example.com',
        provider: 'gmail',
        imap: null,
        credentialSecretId: null,
      });
      const mailbox = new FakeMailbox(accountId);
      ['m1', 'm2', 'm3'].forEach((id) => mailbox.deliver(id));
      mailbox.failOnPage = 1;
      const target = { accountId, folder: 'INBOX', adapter: mailbox, range: ALL };
      await assert.rejects(new Ingestion(db, new SyncCursorStore(db), new ProcessingStore(db)).ingest(target));
      db.close(); // simulated App exit mid-scan

      db = openDatabase(file);
      mailbox.failOnPage = null;
      const result = await new Ingestion(db, new SyncCursorStore(db), new ProcessingStore(db)).ingest(target);
      assert.equal(result.discovered, 1);
      assert.deepEqual(new ProcessingStore(db).countByStage(), { [Stage.queued]: 3 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
