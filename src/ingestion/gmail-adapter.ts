import type { HistoryRange } from '../shared/contracts';
import { fetchJson, HttpError, type FetchLike, type RetryOptions } from './http';
import type { ChangesResult, InitialScanPage, MailAdapter, MessageRef, NormalizedMessage } from './mail-adapter';

// Read-only Gmail adapter. Uses only GET endpoints under the gmail.readonly
// scope, so reading never changes labels, read state, or sends mail.

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PAGE_SIZE = 100;

interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string;
  payload?: GmailPart;
}

interface ListResponse {
  messages?: { id: string; threadId?: string }[];
  nextPageToken?: string;
}

interface HistoryResponse {
  history?: { messagesAdded?: { message: { id: string; threadId?: string; labelIds?: string[] } }[] }[];
  historyId: string;
  nextPageToken?: string;
}

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
}

/** Gmail search query for the configured initial range; undefined reads all history. */
export function rangeQuery(range: HistoryRange, now: Date = new Date()): string | undefined {
  if (range.mode === 'all-history') return undefined;
  let start: Date;
  if (range.mode === 'last-30-days') {
    start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else {
    const [y, m, d] = (range.fromDate ?? '').split('-').map(Number);
    start = new Date(y, m - 1, d); // local midnight on the chosen day
  }
  return `after:${Math.floor(start.getTime() / 1000)}`;
}

/** Splits an address header on commas outside quotes and angle brackets. */
export function splitAddressList(value: string | null): string[] {
  if (!value) return [];
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angle++;
    else if (ch === '>' && !quoted && angle > 0) angle--;
    if (ch === ',' && !quoted && angle === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const decode = (data: string | undefined): string => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/** Reduces an HTML body to readable text for redaction and analysis. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => ENTITIES[name])
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collectParts(part: GmailPart | undefined, mimeType: string, out: string[]): void {
  if (!part) return;
  if (part.mimeType === mimeType && !part.filename && part.body?.data) out.push(decode(part.body.data));
  for (const child of part.parts ?? []) collectParts(child, mimeType, out);
}

/** Prefers text/plain parts, falls back to text/html; attachments are skipped. */
export function extractBodyText(payload: GmailPart | undefined): string {
  const plain: string[] = [];
  collectParts(payload, 'text/plain', plain);
  if (plain.length > 0) return plain.join('\n').trim();
  const html: string[] = [];
  collectParts(payload, 'text/html', html);
  return htmlToText(html.join('\n'));
}

export function parseGmailMessage(accountId: string, message: GmailMessage): NormalizedMessage {
  const headers = new Map<string, string>();
  for (const header of message.payload?.headers ?? []) {
    const key = header.name.toLowerCase();
    if (!headers.has(key)) headers.set(key, header.value);
  }
  const header = (name: string): string | null => headers.get(name) ?? null;
  const internalDate = Number(message.internalDate);
  return {
    accountId,
    providerMessageId: message.id,
    threadId: message.threadId ?? null,
    receivedAt: Number.isFinite(internalDate) && internalDate > 0 ? new Date(internalDate).toISOString() : null,
    from: header('from'),
    to: splitAddressList(header('to')),
    cc: splitAddressList(header('cc')),
    subject: header('subject'),
    internetMessageId: header('message-id'),
    bodyText: extractBodyText(message.payload),
  };
}

export class GmailAdapter implements MailAdapter {
  constructor(
    private readonly accountId: string,
    /** Gmail label for the account's folder scope, e.g. INBOX. */
    private readonly label: string,
    private readonly accessToken: () => Promise<string>,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly retry: RetryOptions = {},
  ) {}

  private async get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const url = new URL(API + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return fetchJson<T>(
      this.fetchImpl,
      url.toString(),
      { headers: { Authorization: `Bearer ${await this.accessToken()}` } },
      this.retry,
    );
  }

  profile(): Promise<GmailProfile> {
    return this.get<GmailProfile>('/profile');
  }

  async currentCursor(): Promise<string> {
    return (await this.profile()).historyId;
  }

  async listInitial(range: HistoryRange, pageToken: string | null): Promise<InitialScanPage> {
    const page = await this.get<ListResponse>('/messages', {
      labelIds: this.label,
      maxResults: String(PAGE_SIZE),
      q: rangeQuery(range),
      pageToken: pageToken ?? undefined,
    });
    return {
      refs: (page.messages ?? []).map((m) => this.ref(m.id, m.threadId)),
      nextPageToken: page.nextPageToken ?? null,
    };
  }

  async listChanges(cursor: string): Promise<ChangesResult> {
    const seen = new Map<string, MessageRef>();
    let pageToken: string | undefined;
    let latest = cursor;
    try {
      do {
        const page = await this.get<HistoryResponse>('/history', {
          startHistoryId: cursor,
          historyTypes: 'messageAdded',
          labelId: this.label,
          maxResults: '500',
          pageToken,
        });
        for (const entry of page.history ?? []) {
          for (const { message } of entry.messagesAdded ?? []) {
            if (!seen.has(message.id)) seen.set(message.id, this.ref(message.id, message.threadId));
          }
        }
        latest = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (error) {
      // Gmail answers 404 when the start history ID is too old to replay.
      if (error instanceof HttpError && error.status === 404) return { status: 'cursor-expired' };
      throw error;
    }
    return { status: 'ok', refs: [...seen.values()], cursor: latest };
  }

  async fetchMessage(ref: MessageRef): Promise<NormalizedMessage> {
    const message = await this.get<GmailMessage>(`/messages/${encodeURIComponent(ref.providerMessageId)}`, {
      format: 'full',
    });
    return parseGmailMessage(this.accountId, message);
  }

  private ref(id: string, threadId: string | undefined): MessageRef {
    return { accountId: this.accountId, providerMessageId: id, threadId: threadId ?? null, receivedAt: null };
  }
}
