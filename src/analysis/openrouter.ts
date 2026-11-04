import { fetchJson, HttpError, type FetchLike, type RetryOptions } from '../ingestion/http';
import type { ChatMessage } from './prompt';

// OpenRouter chat completions. The model is whatever the user configured;
// there is no automatic fallback to another (possibly paid) model.

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  /**
   * When true, ask OpenRouter to route only to providers that do not collect
   * prompts. Many free endpoints do not meet this; requests then fail visibly
   * rather than silently relaxing the restriction.
   */
  denyDataCollection: boolean;
}

export class ModelOutputError extends Error {
  constructor(reason: string) {
    super(`Model output rejected: ${reason}`);
    this.name = 'ModelOutputError';
  }
}

export class DataPolicyUnavailableError extends Error {
  constructor() {
    super('No provider for this model meets the data-collection restriction');
    this.name = 'DataPolicyUnavailableError';
  }
}

interface CompletionResponse {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
}

/**
 * Spaces requests out so a batch stays under OpenRouter's free-model limit
 * (about 20 requests per minute).
 */
export class RequestPacer {
  private next = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async wait(): Promise<void> {
    const now = this.now();
    const start = Math.max(now, this.next);
    this.next = start + this.minIntervalMs;
    if (start > now) await this.sleep(start - now);
  }
}

export const FREE_MODEL_INTERVAL_MS = 3500;
const defaultPacer = new RequestPacer(FREE_MODEL_INTERVAL_MS);

export interface Completion {
  content: string;
  model: string;
}

export async function complete(
  config: OpenRouterConfig,
  messages: ChatMessage[],
  fetchImpl: FetchLike = fetch,
  retry: RetryOptions = { attempts: 2, baseDelayMs: 15_000 },
  pacer: RequestPacer = defaultPacer,
): Promise<Completion> {
  await pacer.wait();
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: 0,
    response_format: { type: 'json_object' },
  };
  if (config.denyDataCollection) body.provider = { data_collection: 'deny' };
  let response: CompletionResponse;
  try {
    response = await fetchJson<CompletionResponse>(
      fetchImpl,
      ENDPOINT,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'AI Scheduling Assistant',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      },
      retry,
    );
  } catch (error) {
    if (config.denyDataCollection && error instanceof HttpError && error.status === 404) {
      throw new DataPolicyUnavailableError();
    }
    throw error;
  }
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new ModelOutputError('empty response');
  return { content, model: response.model ?? config.model };
}

/** Extracts the JSON object from a reply, tolerating code fences or stray prose. */
export function parseJsonObject(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : content;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new ModelOutputError('no JSON object');
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new ModelOutputError('invalid JSON');
  }
}
