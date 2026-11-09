import type { NormalizedMessage } from '../ingestion/mail-adapter';
import type { FetchLike } from '../ingestion/http';
import { Stage } from '../storage/processing-store';
import type { SchedulingStore } from '../storage/scheduling-store';
import type { MessageHandler } from '../sync/queue-worker';
import { complete, parseJsonObject, type OpenRouterConfig, type RequestPacer } from './openrouter';
import { buildPrompt, PROMPT_VERSION } from './prompt';
import { Redactor, type RedactedMessage } from './redaction';
import { validateAnalysis, type SchedulingAnalysis } from './validation';

// The analysis stage of the queue: thread context, local redaction, prompted
// analysis, validation, then storage. Category-to-priority mapping happens in
// local code when the item is saved and listed (T010).

const MAX_THREAD_MESSAGES = 5;

export interface AnalysisDeps {
  store: SchedulingStore;
  /** Throws when OpenRouter is not configured; the item then stays queued. */
  openRouter(): OpenRouterConfig;
  /** Addresses of connected accounts; their mail is the clinician's own. */
  ownerAddresses(): string[];
  /** Earlier messages in the same conversation, when the provider supports it. */
  threadFor?(message: NormalizedMessage): Promise<NormalizedMessage[]>;
  defaultTimeZone: string;
  fetchImpl?: FetchLike;
  /** Overrides request pacing (tests use an interval of 0). */
  pacer?: RequestPacer;
  clock?: () => Date;
}

/** Privacy-minimized result used when redaction fails; nothing is uploaded. */
export const REDACTION_FAILED_ANALYSIS: SchedulingAnalysis = {
  requestType: 'unclear',
  category: null,
  summary: 'An email could not be safely analyzed. Review it in the mailbox.',
  timing: { start: null, end: null, durationMinutes: null, timeZone: null, window: null, agreementEvidence: null },
  urgency: { explicit: false, deadline: null, evidence: null },
  existingMeetingReference: null,
  evidence: [],
  reviewNotes: ['redaction failed; content was not sent for analysis'],
};

/** The target message last, preceded by up to four earlier thread messages. */
export function threadContext(target: NormalizedMessage, thread: NormalizedMessage[]): NormalizedMessage[] {
  const cutoff = target.receivedAt ?? '9999';
  const earlier = thread
    .filter((m) => m.providerMessageId !== target.providerMessageId && (m.receivedAt ?? '') <= cutoff)
    .sort((a, b) => (a.receivedAt ?? '').localeCompare(b.receivedAt ?? ''));
  return [...earlier.slice(-(MAX_THREAD_MESSAGES - 1)), target];
}

/** Everything the model saw, including sender placeholders, for validating its claims. */
export const sourceText = (messages: RedactedMessage[]): string =>
  messages.map((m) => `${m.sender}\n${m.subject}\n${m.body}`).join('\n');

export function createAnalysisHandler(deps: AnalysisDeps): MessageHandler {
  const clock = deps.clock ?? (() => new Date());
  return async (message, item) => {
    const config = deps.openRouter();
    const thread = deps.threadFor ? threadContext(message, await deps.threadFor(message)) : [message];
    const redactor = new Redactor(deps.ownerAddresses());
    const redacted = redactor.redactThread(thread, { stripQuotes: thread.length > 1 });
    const meta = {
      processingItemId: item.id,
      receivedAt: message.receivedAt,
      sourceKey: `${item.accountId}:${item.providerMessageId}`,
      now: clock().toISOString(),
    };

    if (!redacted.ok) {
      // Fail closed: keep a generic local item so the email is not lost.
      deps.store.save(REDACTION_FAILED_ANALYSIS, { ...meta, promptVersion: null, model: null, redactionFailed: true });
      return Stage.analyzed;
    }

    const prompt = buildPrompt({
      messages: redacted.messages,
      senderRole: redacted.senderRole,
      defaultTimeZone: deps.defaultTimeZone,
    });
    const completion = await complete(config, prompt, deps.fetchImpl, undefined, deps.pacer);
    const analysis = validateAnalysis(
      parseJsonObject(completion.content),
      sourceText(redacted.messages),
      deps.defaultTimeZone,
    );
    deps.store.save(analysis, {
      ...meta,
      promptVersion: PROMPT_VERSION,
      model: completion.model,
      redactionFailed: false,
    });
    return Stage.analyzed;
  };
}
