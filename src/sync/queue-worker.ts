import { createHash } from 'node:crypto';
import { HttpError } from '../ingestion/http';
import type { MailAdapter, NormalizedMessage } from '../ingestion/mail-adapter';
import { Stage, type ProcessingItem, type ProcessingStore } from '../storage/processing-store';

// Works through durable queued items. Each item is refetched from its
// provider by source reference (bodies are never stored), handed to the
// pipeline handler, and only then moved to the handler's next stage. If the
// App stops mid-way, the item is still in its old stage and is retried.

/** Moves one fetched message forward; returns the item's next stage. */
export type MessageHandler = (message: NormalizedMessage, item: ProcessingItem) => Promise<string>;

/** Until analysis exists (T008/T009), fetched items wait for it. */
export const awaitAnalysis: MessageHandler = async () => Stage.awaitingAnalysis;

export const MAX_ATTEMPTS = 5;
const BASE_RETRY_MS = 60_000;
const MAX_RETRY_MS = 6 * 60 * 60_000;

export interface WorkerResult {
  processed: number;
  retrying: number;
  failed: number;
  sourceMissing: number;
}

export interface WorkerOptions {
  queue: ProcessingStore;
  adapterFor(accountId: string): MailAdapter | null;
  handler: MessageHandler;
  stages?: string[];
  limit?: number;
  clock?: () => Date;
}

/** Hash used to notice a changed source message; it cannot be reversed into content. */
export function fingerprint(message: NormalizedMessage): string {
  return createHash('sha256')
    .update(message.subject ?? '')
    .update('\0')
    .update(message.bodyText)
    .digest('hex');
}

/** A safe, content-free error code for logs and the database. */
export function errorCode(error: unknown): string {
  if (error instanceof HttpError) return error.code ? `http_${error.status}_${error.code}` : `http_${error.status}`;
  return 'processing_failed';
}

export function retryDelayMs(attempt: number): number {
  return Math.min(BASE_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS);
}

export async function processQueue(options: WorkerOptions): Promise<WorkerResult> {
  const { queue, handler } = options;
  const clock = options.clock ?? (() => new Date());
  const result: WorkerResult = { processed: 0, retrying: 0, failed: 0, sourceMissing: 0 };
  const items = queue.due(options.stages ?? [Stage.queued], clock().toISOString(), options.limit ?? 50);

  for (const item of items) {
    const adapter = options.adapterFor(item.accountId);
    if (!adapter) continue; // account unavailable; leave its work queued
    try {
      const message = await adapter.fetchMessage(item);
      queue.updateSource(item.id, {
        threadId: message.threadId,
        receivedAt: message.receivedAt,
        fingerprint: fingerprint(message),
      });
      const next = await handler(message, item);
      queue.setStage(item.id, next, clock().toISOString());
      result.processed++;
    } catch (error) {
      const now = clock();
      // A deleted source cannot be processed; that is not a cancellation (PRD F07).
      if (error instanceof HttpError && error.status === 404) {
        queue.setStage(item.id, Stage.sourceMissing, now.toISOString());
        result.sourceMissing++;
        continue;
      }
      const attempt = item.attempts + 1;
      const retryAt = attempt >= MAX_ATTEMPTS ? null : new Date(now.getTime() + retryDelayMs(attempt)).toISOString();
      queue.recordFailure(item.id, errorCode(error), retryAt, now.toISOString());
      if (retryAt) result.retrying++;
      else result.failed++;
    }
  }
  return result;
}
