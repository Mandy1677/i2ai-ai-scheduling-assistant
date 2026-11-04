import type { HistoryRange } from '../shared/contracts';

// Normalized contract every mail provider adapter implements
// (docs/ARCHITECTURE.md section 6). Adapters only read; none of these
// operations may send, delete, or change read state.

/** A stable pointer to one provider message, safe to persist. */
export interface MessageRef {
  accountId: string;
  providerMessageId: string;
  threadId: string | null;
  /** ISO timestamp of provider receipt, when known. */
  receivedAt: string | null;
}

/**
 * A fetched message. The body lives in memory only, for redaction and
 * analysis; it must never be persisted or logged.
 */
export interface NormalizedMessage extends MessageRef {
  from: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  /** RFC 5322 Message-ID header, used to match the same mail across sources. */
  internetMessageId: string | null;
  bodyText: string;
}

export interface InitialScanPage {
  refs: MessageRef[];
  /** Pass back to continue the scan; null when the scan is complete. */
  nextPageToken: string | null;
}

export type ChangesResult =
  | { status: 'ok'; refs: MessageRef[]; cursor: string }
  /** The provider can no longer answer from this cursor; rescan the configured range. */
  | { status: 'cursor-expired' };

export interface MailAdapter {
  /**
   * Captures the provider's current change cursor. Take it before the
   * initial scan so mail arriving during the scan is not missed.
   */
  currentCursor(): Promise<string>;
  listInitial(range: HistoryRange, pageToken: string | null): Promise<InitialScanPage>;
  listChanges(cursor: string): Promise<ChangesResult>;
  fetchMessage(ref: MessageRef): Promise<NormalizedMessage>;
  /** Other messages in the same conversation, oldest first, when the provider supports threads. */
  fetchThread?(threadId: string): Promise<NormalizedMessage[]>;
}
