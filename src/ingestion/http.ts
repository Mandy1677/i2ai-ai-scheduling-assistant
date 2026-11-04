export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** An HTTP failure. The message never includes response bodies, which may hold mail content. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    /** Provider error code such as `invalid_grant`, when one was returned. */
    readonly code: string | null = null,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}${code ? ` (${code})` : ''}`);
    this.name = 'HttpError';
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: string | { status?: string } };
    if (typeof body.error === 'string') return body.error;
    return body.error?.status ?? null;
  } catch {
    return null;
  }
}

/** Fetches JSON with bounded exponential backoff on rate limits and server errors. */
export async function fetchJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
  { attempts = 4, baseDelayMs = 500, sleep = defaultSleep }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetchImpl(url, init);
    if (response.ok) return (await response.json()) as T;
    if (!RETRYABLE.has(response.status) || attempt >= attempts) {
      throw new HttpError(response.status, url, await errorCode(response));
    }
    await response.body?.cancel();
    await sleep(baseDelayMs * 2 ** (attempt - 1));
  }
}
