import { createHash } from 'node:crypto';
import type { CalendarConnection } from '../shared/contracts';
import type { RequestType } from '../analysis/validation';
import { priorityLabel } from '../ranking/priority';
import type { CalendarStore, CalendarAssociation } from '../storage/calendar-store';
import type { SchedulingItem, SchedulingStore } from '../storage/scheduling-store';
import type { CalendarClient, EventInput } from './calendar-client';

// T012 (confirmed appointments) and T013 (follow-ups): turn analyzed
// scheduling items into entries in the dedicated calendar.
// - Confirmed items become timed events at the agreed time; nothing else is booked.
// - Unresolved actionable items become all-day, non-blocking "Follow up" entries
//   that move to the current day as the same entry until resolved.
// - Retries reconcile through the item ID stored on each event, so restarts
//   and lost responses never create duplicates.
// - Entries deleted in Google Calendar are never recreated; entries edited
//   there are not overwritten.

const CONFIRMED: RequestType[] = ['confirmed-appointment', 'confirmed-reschedule'];
const FOLLOW_UP: RequestType[] = [
  'scheduling-request',
  'reschedule-request',
  'time-preference',
  'missed-appointment-apology',
  'unclear',
];
const FOLLOW_UP_COLOR = '5'; // "Banana" in Google Calendar

export interface ApplyDeps {
  store: SchedulingStore;
  associations: CalendarStore;
  calendar: CalendarClient;
  connection: CalendarConnection;
  /** Mailbox address for building a link back to the source email. */
  accountAddress(accountId: string): string | null;
  clock?: () => Date;
}

export interface ApplyResult {
  created: number;
  updated: number;
  unchanged: number;
  followUpsMoved: number;
  resolved: number;
  linkedDuplicates: number;
  keptManualEdits: number;
  removedExternally: number;
  skipped: number;
  failed: number;
}

/** YYYY-MM-DD of `date` in `timeZone`. */
export function dateInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const PLACEHOLDER_WORDS: Record<string, string> = {
  '[CLINICIAN]': 'you',
  '[CLINICIAN_EMAIL]': 'your email',
  '[HEALTH_DETAIL]': 'another appointment',
  '[THRIVEWORKS_PR_CONTACT]': 'Jennifer (Thriveworks PR)',
  '[INTERACTIVE_FOUNDATION_CONTACT]': 'Interactive Foundation contact',
  '[VIDEO_MEETING_LINK]': 'video link',
};

/** Restores names from the local alias table; other placeholders become plain words. */
export function restoreText(text: string, aliases: Record<string, string>): string {
  return text.replace(/\[[A-Z][A-Z0-9_]*\]/g, (token) => {
    if (aliases[token]) return aliases[token];
    if (PLACEHOLDER_WORDS[token]) return PLACEHOLDER_WORDS[token];
    return token.slice(1, -1).toLowerCase().replace(/_\d+$/, '').replace(/_/g, ' ');
  });
}

function sourceLink(item: SchedulingItem, address: string | null): string | null {
  if (!address) return null;
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(address)}#all/${encodeURIComponent(item.sourceMessageId)}`;
}

function describe(item: SchedulingItem, address: string | null): string {
  const lines = [restoreText(item.summary, item.aliases), '', `Priority: ${priorityLabel(item.category)}`];
  lines.push(`Type: ${item.requestType.replace(/-/g, ' ')}`);
  if (item.timing?.window) lines.push(`Preferred time: ${item.timing.window}`);
  if (item.deadline) lines.push(`Reply by: ${item.deadline}`);
  if (item.existingMeetingReference) lines.push(`About: ${restoreText(item.existingMeetingReference, item.aliases)}`);
  const link = sourceLink(item, address);
  if (link) lines.push(`Source email: ${link}`);
  lines.push('', 'Added by AI Scheduling Assistant. Nothing was sent to anyone.');
  return lines.join('\n');
}

function shorten(text: string, max = 90): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function appointmentEvent(item: SchedulingItem, address: string | null, fallbackZone: string): EventInput {
  const timing = item.timing!;
  const timeZone = timing.timeZone ?? fallbackZone;
  return {
    summary: shorten(`${priorityLabel(item.category)}: ${restoreText(item.summary, item.aliases)}`),
    description: describe(item, address),
    start: { dateTime: `${timing.start}:00`, timeZone },
    end: { dateTime: `${timing.end}:00`, timeZone },
    transparency: 'opaque',
    itemId: item.id,
  };
}

export function followUpEvent(item: SchedulingItem, address: string | null, date: string): EventInput {
  return {
    summary: shorten(`Follow up · ${priorityLabel(item.category)}: ${restoreText(item.summary, item.aliases)}`),
    description: describe(item, address),
    start: { date },
    end: { date: addDays(date, 1) },
    transparency: 'transparent',
    colorId: FOLLOW_UP_COLOR,
    itemId: item.id,
  };
}

function contentFingerprint(event: EventInput): string {
  return createHash('sha256')
    .update(JSON.stringify([event.summary, event.description, event.transparency, event.start, event.end]))
    .digest('hex');
}

/** Follow-up content only; its date moves daily and is tracked separately. */
function followUpFingerprint(event: EventInput): string {
  return createHash('sha256').update(JSON.stringify([event.summary, event.description])).digest('hex');
}

const threadKey = (item: SchedulingItem): string | null => (item.threadId ? `${item.accountId}:${item.threadId}` : null);

export async function applyToCalendar(deps: ApplyDeps): Promise<ApplyResult> {
  const { store, associations, calendar, connection } = deps;
  const now = (deps.clock ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const today = dateInZone(now, connection.timeZone);
  const result: ApplyResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    followUpsMoved: 0,
    resolved: 0,
    linkedDuplicates: 0,
    keptManualEdits: 0,
    removedExternally: 0,
    skipped: 0,
    failed: 0,
  };
  const items = store.listByPriority();

  // A later confirmation in the same conversation resolves earlier requests.
  const latestConfirmation = new Map<string, string>();
  for (const item of items) {
    const key = threadKey(item);
    if (key && CONFIRMED.includes(item.requestType) && item.receivedAt) {
      const previous = latestConfirmation.get(key);
      if (!previous || item.receivedAt > previous) latestConfirmation.set(key, item.receivedAt);
    }
  }
  // Same conversation + same start = the same appointment from several sources.
  const appointmentEvents = new Map<string, string>();

  const save = (assoc: CalendarAssociation) => associations.save(assoc, nowIso);

  for (const item of items) {
    try {
      const existing = associations.get(item.id);
      if (existing && existing.state !== 'active') {
        result.unchanged++;
        continue;
      }
      const address = deps.accountAddress(item.accountId);

      if (CONFIRMED.includes(item.requestType) && item.timing?.start && item.timing.end) {
        const event = appointmentEvent(item, address, connection.timeZone);
        const fingerprint = contentFingerprint(event);
        const key = threadKey(item);
        const dupKey = key ? `${key}|${item.timing.start}` : null;

        if (!existing && dupKey && appointmentEvents.has(dupKey)) {
          save({
            schedulingItemId: item.id,
            calendarId: connection.calendarId,
            eventId: appointmentEvents.get(dupKey)!,
            kind: 'appointment',
            appliedFingerprint: fingerprint,
            etag: null,
            state: 'active',
            eventDate: null,
          });
          result.linkedDuplicates++;
          continue;
        }
        const applied = await upsert(existing, event, fingerprint, 'appointment', null);
        if (applied && dupKey) appointmentEvents.set(dupKey, applied);
        continue;
      }

      if (FOLLOW_UP.includes(item.requestType)) {
        const key = threadKey(item);
        const confirmedAt = key ? latestConfirmation.get(key) : undefined;
        if (confirmedAt && (!item.receivedAt || confirmedAt >= item.receivedAt)) {
          if (existing) {
            await calendar.deleteEvent(existing.calendarId, existing.eventId);
            save({ ...existing, state: 'resolved' });
            result.resolved++;
          } else {
            result.skipped++;
          }
          continue;
        }
        const receiptDay = item.receivedAt ? dateInZone(new Date(item.receivedAt), connection.timeZone) : today;
        const targetDate = receiptDay > today ? receiptDay : today;
        const event = followUpEvent(item, address, targetDate);
        await upsert(existing, event, followUpFingerprint(event), 'follow-up', targetDate);
        continue;
      }

      result.skipped++; // non-scheduling, or confirmed without complete timing
    } catch {
      result.failed++;
    }
  }
  return result;

  /** Creates, reconciles, or updates one entry; returns its event ID when active. */
  async function upsert(
    existing: CalendarAssociation | null,
    event: EventInput,
    fingerprint: string,
    kind: CalendarAssociation['kind'],
    eventDate: string | null,
  ): Promise<string | null> {
    const base = { schedulingItemId: event.itemId, calendarId: connection.calendarId, kind, state: 'active' as const };

    // A linked duplicate shares another item's event; that item owns its content.
    if (existing && existing.etag === null && kind === 'appointment') {
      result.unchanged++;
      return existing.eventId;
    }

    if (!existing) {
      // Reconcile first: a previous attempt may have created the event before failing.
      const found = await calendar.findByItem(connection.calendarId, event.itemId);
      const written = found ?? (await calendar.insertEvent(connection.calendarId, event));
      save({ ...base, eventId: written.id, appliedFingerprint: fingerprint, etag: written.etag, eventDate });
      if (found) result.unchanged++;
      else result.created++;
      return written.id;
    }

    const contentChanged = existing.appliedFingerprint !== fingerprint;
    const dateChanged = kind === 'follow-up' && existing.eventDate !== eventDate;
    if (!contentChanged && !dateChanged) {
      result.unchanged++;
      return existing.eventId;
    }

    const current = await calendar.getEvent(existing.calendarId, existing.eventId);
    if (!current) {
      save({ ...existing, state: 'removed-externally' });
      result.removedExternally++;
      return null;
    }
    if (existing.etag && current.etag !== existing.etag) {
      // Monica changed this entry in Google Calendar; keep her version.
      result.keptManualEdits++;
      return existing.eventId;
    }
    const patch: Partial<EventInput> = contentChanged
      ? { summary: event.summary, description: event.description, start: event.start, end: event.end }
      : { start: event.start, end: event.end };
    const updated = await calendar.patchEvent(existing.calendarId, existing.eventId, patch);
    save({ ...existing, appliedFingerprint: fingerprint, etag: updated.etag, eventDate });
    if (dateChanged && !contentChanged) result.followUpsMoved++;
    else result.updated++;
    return existing.eventId;
  }
}
