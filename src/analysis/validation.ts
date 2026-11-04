import { CATEGORIES, REQUEST_TYPES } from './prompt';
import { ModelOutputError } from './openrouter';
import { residualLeak } from './redaction';

// Validates model output against the contract in ARCHITECTURE section 7.
// Correct JSON is not enough: claims must be backed by quotes that actually
// appear in the redacted input, and confirmed appointments need complete,
// coherent timing. Unsupported confirmations are downgraded to the
// follow-up path instead of becoming speculative appointments.

export type RequestType = (typeof REQUEST_TYPES)[number];
export type Category = (typeof CATEGORIES)[number];

export interface Timing {
  start: string | null;
  end: string | null;
  durationMinutes: number | null;
  timeZone: string | null;
  window: string | null;
  agreementEvidence: string | null;
}

export interface SchedulingAnalysis {
  requestType: RequestType;
  category: Category | null;
  summary: string;
  timing: Timing;
  urgency: { explicit: boolean; deadline: string | null; evidence: string | null };
  existingMeetingReference: string | null;
  evidence: string[];
  /** Why the result was adjusted locally; empty when accepted as-is. */
  reviewNotes: string[];
}

const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLACEHOLDER = /\[[A-Z][A-Z0-9_]*\]/g;
/** A time of day written in the thread, e.g. "2:00", "10 am", "noon". */
const CLOCK_TIME = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\b\d{1,2}:\d{2}\b|\bnoon\b/i;
/** Thread content that actually indicates PennWest or university duties. */
const PENNWEST_CONTEXT =
  /\[PENNWEST_SENDER\]|\bpenn\s?west\b|\buniversit|\blecture|\bcourse\b|\bclass(?:es)?\b|\bsemester\b|\bstudents?\b|\bfaculty\b|\bprofessor\b|\bsyllabus\b|\bcampus\b/i;
/** Text addressed to the assistant rather than to the clinician. */
const INJECTION =
  /\b(?:ignore|disregard|forget)\b[^.\n]{0,40}\b(?:instructions?|rules|prompt)\b|\bsystem prompt\b|\byou are (?:now )?an? (?:ai|assistant|language model)\b/i;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** True when `quote` appears (ignoring case and spacing) in the source. */
function quoted(quote: string | null, source: string): boolean {
  if (!quote) return false;
  const q = normalize(quote).replace(/^["'“”]+|["'“”.]+$/g, '');
  return q.length >= 3 && source.includes(q);
}

function validLocalDateTime(value: string | null): string | null {
  if (!value || !LOCAL_DATETIME.test(value)) return null;
  const date = new Date(`${value}:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 16) !== value ? null : value;
}

function validZone(value: string | null): string | null {
  if (!value) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** Drops free text from the model that carries identifying details. */
function safeText(value: string | null): string | null {
  return value && !residualLeak(value) ? value : null;
}

function addMinutes(localDateTime: string, minutes: number): string {
  return new Date(new Date(`${localDateTime}:00Z`).getTime() + minutes * 60_000).toISOString().slice(0, 16);
}

export function validateAnalysis(raw: unknown, sourceText: string, defaultTimeZone: string): SchedulingAnalysis {
  if (!isRecord(raw)) throw new ModelOutputError('not an object');
  const notes: string[] = [];
  const source = normalize(sourceText);

  let requestType = raw.requestType as RequestType;
  if (!REQUEST_TYPES.includes(requestType)) throw new ModelOutputError('unknown requestType');

  let category = raw.category === null || raw.category === undefined ? null : (raw.category as Category);
  if (category !== null && !CATEGORIES.includes(category)) throw new ModelOutputError('unknown category');
  // An educational sender domain alone is not PennWest evidence (PRD section 3).
  if (category === 'pennwest' && !PENNWEST_CONTEXT.test(sourceText)) {
    category = null;
    notes.push('PennWest category not supported by the thread content');
  }

  const summary = str(raw.summary);
  if (!summary || summary.length > 300) throw new ModelOutputError('missing or overlong summary');
  if (residualLeak(summary)) throw new ModelOutputError('summary contains identifying details');
  for (const placeholder of summary.match(PLACEHOLDER) ?? []) {
    // [CLINICIAN] is defined by the prompt itself, so it is valid even when the email never names her.
    if (placeholder !== '[CLINICIAN]' && !sourceText.includes(placeholder)) {
      throw new ModelOutputError('summary invents a placeholder');
    }
  }

  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
    .map(str)
    .filter((q): q is string => q !== null && quoted(q, source))
    .slice(0, 5);

  const t = isRecord(raw.timing) ? raw.timing : {};
  const timing: Timing = {
    start: validLocalDateTime(str(t.start)),
    end: validLocalDateTime(str(t.end)),
    durationMinutes:
      typeof t.durationMinutes === 'number' && Number.isInteger(t.durationMinutes) && t.durationMinutes > 0 && t.durationMinutes <= 24 * 60
        ? t.durationMinutes
        : null,
    timeZone: validZone(str(t.timeZone)),
    window: safeText(str(t.window)?.slice(0, 120) ?? null),
    agreementEvidence: quoted(str(t.agreementEvidence), source) ? str(t.agreementEvidence) : null,
  };
  if (timing.start && !timing.end && timing.durationMinutes) {
    timing.end = addMinutes(timing.start, timing.durationMinutes);
  }
  if (timing.start && timing.end && timing.end <= timing.start) {
    timing.end = null;
    notes.push('end time was not after start time');
  }
  if (timing.start && timing.end && !timing.durationMinutes) {
    timing.durationMinutes = Math.round(
      (new Date(`${timing.end}:00Z`).getTime() - new Date(`${timing.start}:00Z`).getTime()) / 60_000,
    );
  }

  const confirmed = requestType === 'confirmed-appointment' || requestType === 'confirmed-reschedule';
  if (confirmed) {
    const problems: string[] = [];
    if (!timing.start) problems.push('no agreed start time');
    if (!timing.end) problems.push('no end time or explicit duration');
    if (!timing.agreementEvidence) problems.push('agreement not supported by a quote from the thread');
    if (!CLOCK_TIME.test(sourceText)) problems.push('no time of day stated in the thread');
    if (INJECTION.test(sourceText)) problems.push('thread contains instructions aimed at the assistant');
    if (problems.length > 0) {
      requestType = requestType === 'confirmed-reschedule' ? 'reschedule-request' : 'scheduling-request';
      notes.push(`confirmation downgraded: ${problems.join('; ')}`);
    } else if (!timing.timeZone) {
      timing.timeZone = defaultTimeZone;
      notes.push(`time zone not stated; using ${defaultTimeZone}`);
    }
  }

  const u = isRecord(raw.urgency) ? raw.urgency : {};
  const urgencyEvidence = quoted(str(u.evidence), source) ? str(u.evidence) : null;
  const deadline = str(u.deadline);
  const urgency = {
    explicit: u.explicit === true && urgencyEvidence !== null,
    deadline: deadline && DATE.test(deadline) && urgencyEvidence ? deadline : null,
    evidence: urgencyEvidence,
  };

  return {
    requestType,
    category,
    summary,
    timing,
    urgency,
    existingMeetingReference: safeText(str(raw.existingMeetingReference)?.slice(0, 200) ?? null),
    evidence,
    reviewNotes: notes,
  };
}
