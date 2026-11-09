import type { DatabaseSync } from 'node:sqlite';
import type { ApplyResult } from '../calendar/apply';
import type { MailAdapter, NormalizedMessage } from '../ingestion/mail-adapter';
import type { AppFailure, HistoryRange } from '../shared/contracts';
import type { AccountStore } from '../storage/account-store';
import { Stage, type ProcessingStore } from '../storage/processing-store';
import type { SyncCursorStore } from '../storage/sync-cursor-store';
import { Ingestion } from './ingestion';
import { MAX_ATTEMPTS, processQueue, type MessageHandler } from './queue-worker';

// One synchronization run (T016): discover mail for every connected account,
// analyze the queue, then apply results to the dedicated calendar. Each
// account is independent, so one failing does not block the others, but its
// failure is reported (docs/DESIGN.md section 3).

const BATCH_SIZE = 50;
const MAX_BATCHES = 20;

export interface SyncRunDeps {
  db: DatabaseSync;
  accounts: AccountStore;
  cursors: SyncCursorStore;
  queue: ProcessingStore;
  range: HistoryRange;
  /** A read-only adapter for a connected account; throws when one cannot be built. */
  adapterFor(accountId: string): MailAdapter;
  /** The analysis stage, given a way to read earlier messages in a conversation. */
  analysis(threadFor: (message: NormalizedMessage) => Promise<NormalizedMessage[]>): MessageHandler;
  /** Writes analyzed items to the dedicated calendar; null when it is not connected. */
  applyCalendar(): Promise<ApplyResult | null>;
  /** True when a provider rejected the stored sign-in. */
  needsReconnect(error: unknown): boolean;
  shouldStop?: () => boolean;
  clock?: () => Date;
  batchSize?: number;
  maxBatches?: number;
}

export interface SyncReport {
  /** Failures describing the state after this run; they replace the previous run's. */
  failures: AppFailure[];
  /** Possible missed mail; these stay visible until the range is changed. */
  possibleGaps: AppFailure[];
  /** Email changes that met an entry Monica edited; these stay until she opens the calendar. */
  editNotices: AppFailure[];
  discovered: number;
  processed: number;
  calendar: ApplyResult | null;
  stopped: boolean;
}

// Same format as failureIdFor in src/main/account-connector.ts, so a
// successful reconnect clears it.
const accountFailureId = (accountId: string): string => `account:${accountId}`;

/**
 * Main-window failures for added accounts that are not being synced: never
 * connected, or their stored sign-in was rejected. They stay until fixed.
 */
export function accountStateFailures(accounts: AccountStore): AppFailure[] {
  const failures: AppFailure[] = [];
  for (const account of accounts.list()) {
    if (account.connectionState === 'needs-reconnect') {
      failures.push({
        id: accountFailureId(account.id),
        message: `Reconnect an email account: ${account.address} needs to sign in again.`,
        action: `Open Settings and click Reconnect next to ${account.address}.`,
      });
    } else if (account.connectionState === 'not-connected') {
      failures.push({
        id: accountFailureId(account.id),
        message: `${account.address} is not connected, so its mail is not being checked.`,
        action:
          account.provider === 'gmail'
            ? `Open Settings and click Connect next to ${account.address}.`
            : 'Connecting this kind of account is not available in this build yet.',
      });
    }
  }
  return failures;
}

const emails = (n: number): string => (n === 1 ? '1 email' : `${n} emails`);

/** Failures derived from the durable queue, so they survive restarts and clear when items succeed. */
export function queueFailures(queue: ProcessingStore, rateLimited: boolean): AppFailure[] {
  const failures: AppFailure[] = [];
  let dataPolicy = 0;
  let limited = 0;
  let retrying = 0;
  let gaveUp = 0;
  for (const { stage, errorCode, count } of queue.errorSummary()) {
    if (stage === Stage.failed) gaveUp += count;
    else if (errorCode === 'data_policy_unavailable_error') dataPolicy += count;
    else if (errorCode.startsWith('http_429')) limited += count;
    else if (stage === Stage.queued || stage === Stage.awaitingAnalysis) retrying += count;
  }
  if (dataPolicy > 0) {
    failures.push({
      id: 'ai-data-policy',
      message: 'AI analysis could not be completed: no provider for the chosen model keeps emails out of data collection.',
      action: 'Choose a different OpenRouter model in Settings.',
    });
  }
  if (rateLimited || limited > 0) {
    failures.push({
      id: 'ai-rate-limited',
      message: 'AI analysis is paused because OpenRouter is limiting requests.',
      action: 'The App will try again automatically. Click Sync now in a few minutes, or choose another model in Settings.',
    });
  }
  if (retrying > 0) {
    failures.push({
      id: 'processing-retrying',
      message: `${emails(retrying)} could not be processed yet.`,
      action: 'The App will try again automatically. Check the internet connection if this continues.',
    });
  }
  if (gaveUp > 0) {
    failures.push({
      id: 'processing-gave-up',
      message: `${emails(gaveUp)} could not be processed after ${MAX_ATTEMPTS} attempts.`,
      action: 'They will not be retried automatically. Check them in the mailbox.',
    });
  }
  return failures;
}

export async function runSync(deps: SyncRunDeps): Promise<SyncReport> {
  const stop = deps.shouldStop ?? (() => false);
  const report: SyncReport = {
    failures: [],
    possibleGaps: [],
    editNotices: [],
    discovered: 0,
    processed: 0,
    calendar: null,
    stopped: false,
  };
  const ingestion = new Ingestion(deps.db, deps.cursors, deps.queue, deps.clock);
  const adapters = new Map<string, MailAdapter>();

  for (const summary of deps.accounts.list()) {
    if (stop()) return { ...report, stopped: true };
    const account = deps.accounts.get(summary.id);
    if (!account || account.connectionState !== 'connected') continue;
    try {
      const adapter = deps.adapterFor(account.id);
      const result = await ingestion.ingest({
        accountId: account.id,
        folder: account.folderScope,
        adapter,
        range: deps.range,
      });
      report.discovered += result.discovered;
      adapters.set(account.id, adapter);
      if (result.possibleGap) {
        report.possibleGaps.push({
          id: `gap:${account.id}`,
          message: `Some mail in ${account.address} may have been missed.`,
          action: 'The saved sync point expired. Choose a longer email range in Settings to check older mail.',
        });
      }
    } catch (error) {
      if (deps.needsReconnect(error)) {
        // Shown through accountStateFailures until the account is reconnected.
        deps.accounts.setConnection(account.id, 'needs-reconnect', account.credentialSecretId);
        continue;
      }
      report.failures.push({
        id: accountFailureId(account.id),
        message: `Could not check mail for ${account.address}.`,
        action: 'Check the internet connection. The App will try again in a few minutes, or click Sync now.',
      });
    }
  }

  // Messages are only fetched for accounts that were reachable in this run;
  // other accounts' work stays queued.
  const handler = deps.analysis(async (message) => {
    const adapter = adapters.get(message.accountId);
    return message.threadId && adapter?.fetchThread ? adapter.fetchThread(message.threadId) : [];
  });
  let rateLimited = false;
  const maxBatches = deps.maxBatches ?? MAX_BATCHES;
  for (let batch = 0; batch < maxBatches && !stop(); batch++) {
    const result = await processQueue({
      queue: deps.queue,
      adapterFor: (accountId) => adapters.get(accountId) ?? null,
      handler,
      stages: [Stage.queued, Stage.awaitingAnalysis],
      limit: deps.batchSize ?? BATCH_SIZE,
      clock: deps.clock,
      shouldStop: stop,
    });
    report.processed += result.processed;
    if (result.rateLimited) {
      rateLimited = true;
      break;
    }
    if (result.processed + result.retrying + result.failed + result.sourceMissing === 0) break;
  }
  report.failures.push(...queueFailures(deps.queue, rateLimited));
  if (stop()) return { ...report, stopped: true };

  // Follow-ups move to the current day even when no new mail arrived.
  try {
    report.calendar = await deps.applyCalendar();
    if (!report.calendar) {
      report.failures.push({
        id: 'calendar-sync',
        message: 'Calendar access needs attention.',
        action: 'Open Settings and click Connect Google Calendar.',
      });
    } else if (report.calendar.failed > 0) {
      report.failures.push({
        id: 'calendar-sync',
        message: `Calendar access needs attention: ${report.calendar.failed} calendar ${report.calendar.failed === 1 ? 'entry' : 'entries'} could not be written.`,
        action: 'The App will try again in a few minutes. If this continues, reconnect Google Calendar in Settings.',
      });
    }
    if (report.calendar && report.calendar.manualEditConflicts > 0) {
      const n = report.calendar.manualEditConflicts;
      report.editNotices.push({
        id: 'calendar-manual-edits',
        message: `A newer email changed ${n === 1 ? 'an entry' : `${n} entries`} you edited in Google Calendar. Your version was kept.`,
        action: 'Open Google Calendar to check whether it still matches.',
      });
    }
  } catch {
    report.failures.push({
      id: 'calendar-sync',
      message: 'Calendar access needs attention.',
      action: 'Check the internet connection, then click Sync now. If this continues, reconnect Google Calendar in Settings.',
    });
  }
  return report;
}
