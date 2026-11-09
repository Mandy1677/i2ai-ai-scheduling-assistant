import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DataPolicyUnavailableError } from '../analysis/openrouter';
import type { ApplyResult } from '../calendar/apply';
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
import { SecretStore } from '../storage/secret-store';
import { SyncCursorStore } from '../storage/sync-cursor-store';
import { fakeEncryptor } from '../storage/test-helpers';
import { SyncCoordinator } from './coordinator';
import type { MessageHandler } from './queue-worker';
import { accountStateFailures, runSync, type SyncRunDeps } from './run';

const ALL: HistoryRange = { mode: 'all-history', fromDate: null };

/** Minimal mailbox: an initial scan of `ids`, then whatever `deliver` adds. */
class Mailbox implements MailAdapter {
  ids: string[] = [];
  pending: string[] = [];
  failWith: Error | null = null;
  expired = false;
  threadRequests: string[] = [];

  constructor(private readonly accountId: string) {}

  private ref(id: string): MessageRef {
    return { accountId: this.accountId, providerMessageId: id, threadId: `t-${id}`, receivedAt: null };
  }

  async currentCursor(): Promise<string> {
    if (this.failWith) throw this.failWith;
    return '1';
  }

  async listInitial(): Promise<InitialScanPage> {
    if (this.failWith) throw this.failWith;
    return { refs: this.ids.map((id) => this.ref(id)), nextPageToken: null };
  }

  async listChanges(): Promise<ChangesResult> {
    if (this.failWith) throw this.failWith;
    if (this.expired) return { status: 'cursor-expired' };
    const refs = this.pending.map((id) => this.ref(id));
    this.pending = [];
    return { status: 'ok', refs, cursor: '2' };
  }

  async fetchMessage(ref: MessageRef): Promise<NormalizedMessage> {
    if (this.failWith) throw this.failWith;
    return {
      ...ref,
      receivedAt: '2026-11-01T10:00:00.000Z',
      from: 'sender@example.com',
      to: [],
      cc: [],
      subject: null,
      internetMessageId: null,
      bodyText: 'body',
    };
  }

  async fetchThread(threadId: string): Promise<NormalizedMessage[]> {
    this.threadRequests.push(threadId);
    return [];
  }
}

const applied = (overrides: Partial<ApplyResult> = {}): ApplyResult => ({
  created: 0,
  updated: 0,
  unchanged: 0,
  followUpsMoved: 0,
  resolved: 0,
  linkedDuplicates: 0,
  keptManualEdits: 0,
  manualEditConflicts: 0,
  removedExternally: 0,
  rescheduled: 0,
  rescheduleNeedsAttention: 0,
  conflictsMarked: 0,
  conflictsCleared: 0,
  skipped: 0,
  failed: 0,
  ...overrides,
});

function setup() {
  const db = openDatabase(':memory:');
  const accounts = new AccountStore(db);
  const secrets = new SecretStore(db, fakeEncryptor());
  const addAccount = (address: string) => {
    const id = accounts.add({ address, provider: 'gmail', imap: null, credentialSecretId: null });
    accounts.setConnection(id, 'connected', secrets.save('refresh-token'));
    return id;
  };
  const a = addAccount('a@example.com');
  const b = addAccount('b@example.com');
  const mailboxes = new Map([
    [a, new Mailbox(a)],
    [b, new Mailbox(b)],
  ]);
  const queue = new ProcessingStore(db);
  const handled: string[] = [];
  let handler: MessageHandler = async (message) => {
    handled.push(message.providerMessageId);
    return Stage.analyzed;
  };
  let calendarCalls = 0;
  let calendar: () => Promise<ApplyResult | null> = async () => applied();
  let now = new Date('2026-11-04T12:00:00Z');

  const deps = (overrides: Partial<SyncRunDeps> = {}): SyncRunDeps => ({
    db,
    accounts,
    cursors: new SyncCursorStore(db),
    queue,
    range: ALL,
    adapterFor: (id) => {
      const mailbox = mailboxes.get(id);
      if (!mailbox) throw new Error('unknown account');
      return mailbox;
    },
    analysis: (threadFor) => async (message, item) => {
      await threadFor(message);
      return handler(message, item);
    },
    applyCalendar: () => {
      calendarCalls++;
      return calendar();
    },
    needsReconnect: (error) => error instanceof HttpError && error.code === 'invalid_grant',
    clock: () => now,
    ...overrides,
  });
  return {
    db,
    accounts,
    queue,
    a,
    b,
    mailA: mailboxes.get(a)!,
    mailB: mailboxes.get(b)!,
    handled,
    deps,
    setHandler: (h: MessageHandler) => (handler = h),
    setCalendar: (c: () => Promise<ApplyResult | null>) => (calendar = c),
    calendarCalls: () => calendarCalls,
    setNow: (iso: string) => (now = new Date(iso)),
  };
}

const ids = (failures: { id: string }[]) => failures.map((f) => f.id);

describe('sync run', () => {
  test('ingests, analyzes, and applies every account in one run', async () => {
    const t = setup();
    t.mailA.ids = ['a1', 'a2'];
    t.mailB.ids = ['b1'];
    const report = await runSync(t.deps());
    assert.equal(report.discovered, 3);
    assert.equal(report.processed, 3);
    assert.deepEqual(t.handled.sort(), ['a1', 'a2', 'b1']);
    assert.deepEqual(t.mailA.threadRequests.sort(), ['t-a1', 't-a2'], 'conversation context is read');
    assert.equal(t.calendarCalls(), 1);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(t.queue.countByStage(), { [Stage.analyzed]: 3 });
  });

  test('one unreachable account does not block another, and is reported', async () => {
    const t = setup();
    t.mailA.ids = ['a1'];
    t.mailB.ids = ['b1'];
    t.mailA.failWith = new Error('network down');
    const report = await runSync(t.deps());
    assert.deepEqual(t.handled, ['b1']);
    assert.deepEqual(ids(report.failures), [`account:${t.a}`]);
    assert.match(report.failures[0].message, /a@example\.com/);
    assert.equal(t.calendarCalls(), 1, 'calendar is still updated');

    // Recovery clears the warning on the next run.
    t.mailA.failWith = null;
    const next = await runSync(t.deps());
    assert.deepEqual(next.failures, []);
    assert.deepEqual(t.handled.sort(), ['a1', 'b1']);
  });

  test('queued mail for an account that becomes unreachable stays queued without spending attempts', async () => {
    const t = setup();
    t.mailA.ids = ['a1'];
    t.setHandler(async () => {
      throw new HttpError(503, 'https://openrouter.ai/x');
    });
    await runSync(t.deps());
    const [before] = t.queue.due([Stage.queued], '9999', 10);
    assert.equal(before.attempts, 1);

    t.mailA.failWith = new Error('network down');
    t.setNow('2026-11-05T12:00:00Z'); // retry is due
    await runSync(t.deps());
    assert.equal(t.queue.get(before.id)!.attempts, 1);
  });

  test('a rejected sign-in marks the account for reconnection', async () => {
    const t = setup();
    t.mailA.failWith = new HttpError(400, 'https://oauth2.googleapis.com/token', 'invalid_grant');
    const report = await runSync(t.deps());
    assert.deepEqual(report.failures, []);
    assert.equal(t.accounts.get(t.a)!.connectionState, 'needs-reconnect');
    const failures = accountStateFailures(t.accounts);
    assert.deepEqual(ids(failures), [`account:${t.a}`]);
    assert.match(failures[0].action, /Reconnect next to a@example\.com/);

    // It is skipped until reconnected.
    t.mailA.failWith = null;
    t.mailA.ids = ['a1'];
    await runSync(t.deps());
    assert.deepEqual(t.handled, []);
  });

  test('a rate limit stops the batch and shows a recovery action', async () => {
    const t = setup();
    t.mailA.ids = ['a1', 'a2', 'a3'];
    let calls = 0;
    t.setHandler(async () => {
      calls++;
      throw new HttpError(429, 'https://openrouter.ai/api/v1/chat/completions');
    });
    const report = await runSync(t.deps());
    assert.equal(calls, 1, 'remaining items keep their attempts');
    assert.deepEqual(ids(report.failures), ['ai-rate-limited']);
    assert.match(report.failures[0].action, /try again automatically/);
  });

  test('an unmet data-collection restriction asks for another model', async () => {
    const t = setup();
    t.mailA.ids = ['a1'];
    t.setHandler(async () => {
      throw new DataPolicyUnavailableError();
    });
    const report = await runSync(t.deps());
    assert.deepEqual(ids(report.failures), ['ai-data-policy']);
    assert.match(report.failures[0].action, /different OpenRouter model/);
  });

  test('other analysis failures retry, then are reported after giving up', async () => {
    const t = setup();
    t.mailA.ids = ['a1'];
    t.setHandler(async () => {
      throw new HttpError(502, 'https://openrouter.ai/x');
    });
    let report = await runSync(t.deps());
    assert.deepEqual(ids(report.failures), ['processing-retrying']);
    for (let day = 5; day <= 9; day++) {
      t.setNow(`2026-11-${String(day).padStart(2, '0')}T12:00:00Z`);
      report = await runSync(t.deps());
    }
    assert.deepEqual(ids(report.failures), ['processing-gave-up']);
    assert.match(report.failures[0].message, /1 email could not be processed after 5 attempts/);
  });

  test('calendar problems are reported without losing analyzed work', async () => {
    const t = setup();
    t.mailA.ids = ['a1'];
    t.setCalendar(async () => null);
    let report = await runSync(t.deps());
    assert.deepEqual(ids(report.failures), ['calendar-sync']);
    assert.match(report.failures[0].action, /Connect Google Calendar/);
    assert.deepEqual(t.queue.countByStage(), { [Stage.analyzed]: 1 });

    t.setCalendar(async () => applied({ failed: 2 }));
    report = await runSync(t.deps());
    assert.match(report.failures[0].message, /2 calendar entries could not be written/);

    t.setCalendar(async () => applied({ manualEditConflicts: 1 }));
    report = await runSync(t.deps());
    assert.deepEqual(ids(report.failures), []);
    assert.deepEqual(ids(report.editNotices), ['calendar-manual-edits']);
    assert.match(report.editNotices[0].message, /changed an entry you edited/);

    t.setCalendar(async () => {
      throw new Error('offline');
    });
    report = await runSync(t.deps());
    assert.deepEqual(ids(report.failures), ['calendar-sync']);
  });

  test('an expired cursor beyond the configured range reports possible missed mail', async () => {
    const t = setup();
    const range: HistoryRange = { mode: 'last-30-days', fromDate: null };
    await runSync(t.deps({ range }));
    t.mailA.expired = true;
    t.setNow('2026-12-20T12:00:00Z');
    const report = await runSync(t.deps({ range }));
    assert.deepEqual(ids(report.possibleGaps), [`gap:${t.a}`]);
  });

  test('a stop request ends the run before calendar writes', async () => {
    const t = setup();
    t.mailA.ids = ['a1', 'a2'];
    let stop = false;
    t.setHandler(async () => {
      stop = true;
      return Stage.analyzed;
    });
    const report = await runSync(t.deps({ shouldStop: () => stop }));
    assert.equal(report.stopped, true);
    assert.equal(report.processed, 1, 'the second item waits for the next launch');
    assert.equal(t.calendarCalls(), 0);
  });
});

describe('account warnings', () => {
  test('added accounts that are not connected are reported until connected', async () => {
    const t = setup();
    const gmail = t.accounts.add({ address: 'new@gmail.com', provider: 'gmail', imap: null, credentialSecretId: null });
    t.accounts.add({
      address: 'me@comcast.net',
      provider: 'imap',
      imap: { host: 'imap.comcast.net', port: 993, username: 'me' },
      credentialSecretId: null,
    });
    const failures = accountStateFailures(t.accounts);
    assert.equal(failures.length, 2);
    const forGmail = failures.find((f) => f.message.startsWith('new@gmail.com'))!;
    const forImap = failures.find((f) => f.message.startsWith('me@comcast.net'))!;
    assert.match(forGmail.message, /is not connected/);
    assert.match(forGmail.action, /click Connect next to new@gmail\.com/);
    assert.match(forImap.action, /not available in this build yet/);
    assert.equal(forGmail.id, `account:${gmail}`, 'cleared by the same ID a successful connect clears');

    // Connected accounts produce no warning.
    t.accounts.setConnection(gmail, 'connected', null);
    assert.equal(accountStateFailures(t.accounts).length, 1);
  });
});

describe('sync coordinator', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('runs at most once at a time and reports busy state', async () => {
    let release!: () => void;
    let runs = 0;
    const states: boolean[] = [];
    const coordinator = new SyncCoordinator(
      () => true,
      () => {
        runs++;
        return new Promise<void>((resolve) => (release = resolve));
      },
      () => undefined,
      (running) => states.push(running),
    );
    assert.deepEqual(coordinator.requestSync(), { status: 'started' });
    assert.deepEqual(coordinator.requestSync(), { status: 'already-running' });
    release();
    await coordinator.whenIdle();
    assert.equal(runs, 1);
    assert.deepEqual(states, [true, false]);
  });

  test('requires configuration', () => {
    const coordinator = new SyncCoordinator(() => false, async () => undefined, () => undefined);
    assert.deepEqual(coordinator.requestSync(), { status: 'configuration-required' });
  });

  test('the schedule requests runs, skipping ticks during an active run', async () => {
    let runs = 0;
    let release: (() => void) | null = null;
    const coordinator = new SyncCoordinator(
      () => true,
      () => {
        runs++;
        return new Promise<void>((resolve) => (release = resolve));
      },
      () => undefined,
    );
    coordinator.schedule(5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(runs, 1, 'ticks during the run were skipped');
    release!();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(runs >= 2, 'a later tick starts a new run');
    coordinator.stop();
    release!();
    await coordinator.whenIdle();
  });

  test('stop ends scheduling, signals the active run, and refuses new runs', async () => {
    let signal: (() => boolean) | null = null;
    let release!: () => void;
    const coordinator = new SyncCoordinator(
      () => true,
      (shouldStop) => {
        signal = shouldStop;
        return new Promise<void>((resolve) => (release = resolve));
      },
      () => undefined,
    );
    coordinator.requestSync();
    assert.equal(signal!(), false);
    coordinator.stop();
    assert.equal(signal!(), true);
    release();
    await coordinator.whenIdle();
    await tick();
    assert.deepEqual(coordinator.requestSync(), { status: 'already-running' });
  });

  test('a failed run is reported and the coordinator stays usable', async () => {
    const errors: unknown[] = [];
    let fail = true;
    const coordinator = new SyncCoordinator(
      () => true,
      async () => {
        if (fail) throw new Error('boom');
      },
      (error) => errors.push(error),
    );
    coordinator.requestSync();
    await coordinator.whenIdle();
    assert.equal(errors.length, 1);
    fail = false;
    assert.deepEqual(coordinator.requestSync(), { status: 'started' });
    await coordinator.whenIdle();
  });
});
