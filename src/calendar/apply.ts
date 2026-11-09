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
// T014 (rescheduling) and T015 (conflicts):
// - An unconfirmed reschedule keeps the original appointment; its follow-up
//   says which appointment is kept.
// - A confirmed reschedule moves the original only when the conversation has
//   exactly one App appointment it can be; otherwise, or when Monica edited
//   the original, it becomes an attention follow-up and nothing is changed.
// - Overlapping appointments keep their agreed times and are marked with each
//   other's priorities for Monica to resolve.

const CONFIRMED: RequestType[] = ['confirmed-appointment', 'confirmed-reschedule'];
const FOLLOW_UP: RequestType[] = [
  'scheduling-request',
  'reschedule-request',
  'time-preference',
  'missed-appointment-apology',
  'unclear',
];
const FOLLOW_UP_COLOR = '5'; // "Banana" in Google Calendar
const RESCHEDULE_ATTENTION =
  'A new time was agreed, but the App could not safely tell which appointment to move, or the original was changed in Google Calendar. Update the appointment yourself, then delete this reminder.';

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
  /** Email changes newly found to conflict with an entry Monica edited; each is reported once. */
  manualEditConflicts: number;
  removedExternally: number;
  rescheduled: number;
  rescheduleNeedsAttention: number;
  conflictsMarked: number;
  conflictsCleared: number;
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

/** Milliseconds since the epoch for a local `YYYY-MM-DDTHH:MM` time in `timeZone`. */
export function zonedToUtc(local: string, timeZone: string): number {
  const [datePart, timePart = '00:00'] = local.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
  const offsetAt = (ts: number): number => {
    const parts = Object.fromEntries(format.formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - ts;
  };
  // Second pass corrects the offset near daylight-saving changes.
  return asUtc - offsetAt(asUtc - offsetAt(asUtc));
}

/** e.g. "2026-11-12 14:00–14:50". */
export function formatTiming(timing: { start: string | null; end: string | null }): string {
  const start = (timing.start ?? '').replace('T', ' ');
  const end = timing.end ?? '';
  return end.slice(0, 10) === start.slice(0, 10) ? `${start}–${end.slice(11)}` : `${start} – ${end.replace('T', ' ')}`;
}

function describe(item: SchedulingItem, address: string | null, notes: string[] = []): string {
  const lines = [restoreText(item.summary, item.aliases), '', `Priority: ${priorityLabel(item.category)}`];
  lines.push(`Type: ${item.requestType.replace(/-/g, ' ')}`);
  if (item.timing?.window) lines.push(`Preferred time: ${item.timing.window}`);
  if (item.deadline) lines.push(`Reply by: ${item.deadline}`);
  if (item.existingMeetingReference) lines.push(`About: ${restoreText(item.existingMeetingReference, item.aliases)}`);
  lines.push(...notes);
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

export function followUpEvent(item: SchedulingItem, address: string | null, date: string, notes: string[] = []): EventInput {
  return {
    summary: shorten(`Follow up · ${priorityLabel(item.category)}: ${restoreText(item.summary, item.aliases)}`),
    description: describe(item, address, notes),
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

/** Marks an appointment with the appointments it overlaps; times are never changed. */
export function withConflicts(event: EventInput, others: SchedulingItem[]): EventInput {
  const lines = others.map(
    (other) => `- ${priorityLabel(other.category)}: ${restoreText(other.summary, other.aliases)} (${formatTiming(other.timing!)})`,
  );
  return {
    ...event,
    summary: shorten(`Conflict · ${event.summary}`),
    description: ['Conflict: overlaps with', ...lines, 'Both times are kept as agreed; decide which one to move.', '', event.description].join('\n'),
  };
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
    manualEditConflicts: 0,
    rescheduled: 0,
    rescheduleNeedsAttention: 0,
    conflictsMarked: 0,
    conflictsCleared: 0,
    skipped: 0,
    failed: 0,
  };
  const items = store.listByPriority();
  // Moves need their originals applied first, and are applied in the order they were agreed.
  const isMove = (item: SchedulingItem) => item.requestType === 'confirmed-reschedule';
  const ordered = [
    ...items.filter((item) => !isMove(item)),
    ...items.filter(isMove).sort((a, b) => (a.receivedAt ?? '').localeCompare(b.receivedAt ?? '')),
  ];

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
  const followUpDate = (item: SchedulingItem): string => {
    const receiptDay = item.receivedAt ? dateInZone(new Date(item.receivedAt), connection.timeZone) : today;
    return receiptDay > today ? receiptDay : today;
  };

  for (const item of ordered) {
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
        if (isMove(item) && (!existing || existing.kind === 'follow-up')) {
          if (await applyReschedule(item, existing, address, dupKey)) continue;
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
        const targetDate = followUpDate(item);
        // An unconfirmed reschedule never touches the original; say which one is kept.
        const kept = item.requestType === 'reschedule-request' ? originalsFor(item) : [];
        const notes = kept.length === 1 ? [`Current appointment kept: ${formatTiming(kept[0].item.timing!)}`] : [];
        const event = followUpEvent(item, address, targetDate, notes);
        await upsert(existing, event, followUpFingerprint(event), 'follow-up', targetDate);
        continue;
      }

      result.skipped++; // non-scheduling, or confirmed without complete timing
    } catch {
      result.failed++;
    }
  }
  await markConflicts();
  return result;

  /**
   * App appointments in the same conversation, received no later than `item`,
   * at a different time: the ones a reschedule could be moving. One entry per event.
   */
  function originalsFor(item: SchedulingItem): { item: SchedulingItem; assoc: CalendarAssociation }[] {
    const key = threadKey(item);
    if (!key) return [];
    const found = new Map<string, { item: SchedulingItem; assoc: CalendarAssociation }>();
    for (const other of items) {
      if (other.id === item.id || threadKey(other) !== key || !CONFIRMED.includes(other.requestType)) continue;
      if (item.receivedAt && other.receivedAt && other.receivedAt > item.receivedAt) continue;
      if (!other.timing?.start || other.timing.start === item.timing?.start) continue;
      const assoc = associations.get(other.id);
      // Linked duplicates (no etag) share their owner's event.
      if (!assoc || assoc.state !== 'active' || assoc.kind !== 'appointment' || assoc.etag === null) continue;
      found.set(assoc.eventId, { item: other, assoc });
    }
    return [...found.values()];
  }

  /**
   * Applies a confirmed reschedule. Returns false when no original is in this
   * calendar, so the new time is written as an ordinary confirmed appointment.
   */
  async function applyReschedule(
    item: SchedulingItem,
    existing: CalendarAssociation | null,
    address: string | null,
    dupKey: string | null,
  ): Promise<boolean> {
    const attention = async (assoc: CalendarAssociation | null) => {
      const date = followUpDate(item);
      const event = followUpEvent(item, address, date, [RESCHEDULE_ATTENTION]);
      await upsert(assoc, event, followUpFingerprint(event), 'follow-up', date);
    };
    // An attention reminder from an earlier run stays until Monica removes it.
    if (existing) {
      await attention(existing);
      return true;
    }
    const originals = originalsFor(item);
    if (originals.length === 0) return false;
    if (originals.length === 1) {
      const original = originals[0].assoc;
      const current = await calendar.getEvent(original.calendarId, original.eventId);
      if (!current) {
        save({ ...original, state: 'removed-externally' });
        result.removedExternally++;
        return false;
      }
      if (current.etag === original.etag) {
        const event = appointmentEvent(item, address, connection.timeZone);
        const updated = await calendar.patchEvent(original.calendarId, original.eventId, {
          summary: event.summary,
          description: event.description,
          start: event.start,
          end: event.end,
        });
        save({
          schedulingItemId: item.id,
          calendarId: original.calendarId,
          eventId: original.eventId,
          kind: 'appointment',
          appliedFingerprint: contentFingerprint(event),
          etag: updated.etag,
          state: 'active',
          eventDate: null,
          conflictKey: null,
        });
        save({ ...original, state: 'rescheduled' });
        if (dupKey) appointmentEvents.set(dupKey, original.eventId);
        result.rescheduled++;
        return true;
      }
    }
    // Several possible originals, or Monica changed it: do not guess.
    await attention(null);
    result.rescheduleNeedsAttention++;
    return true;
  }

  /** Marks or clears overlaps between App appointments, keeping every agreed time. */
  async function markConflicts(): Promise<void> {
    const booked: { item: SchedulingItem; assoc: CalendarAssociation; start: number; end: number }[] = [];
    for (const item of items) {
      if (!CONFIRMED.includes(item.requestType) || !item.timing?.start || !item.timing.end) continue;
      const assoc = associations.get(item.id);
      if (!assoc || assoc.state !== 'active' || assoc.kind !== 'appointment' || assoc.etag === null) continue;
      const zone = item.timing.timeZone ?? connection.timeZone;
      try {
        booked.push({ item, assoc, start: zonedToUtc(item.timing.start, zone), end: zonedToUtc(item.timing.end, zone) });
      } catch {
        // An unknown time zone cannot be compared; it is still written as agreed.
      }
    }
    for (const entry of booked) {
      const overlaps = booked.filter(
        (other) => other.assoc.eventId !== entry.assoc.eventId && other.start < entry.end && entry.start < other.end,
      );
      const key = overlaps.length
        ? JSON.stringify(overlaps.map((o) => [o.item.id, o.item.category, o.item.timing!.start, o.item.timing!.end]).sort())
        : null;
      if (key === (entry.assoc.conflictKey ?? null)) continue;
      try {
        const current = await calendar.getEvent(entry.assoc.calendarId, entry.assoc.eventId);
        if (!current) {
          save({ ...entry.assoc, state: 'removed-externally' });
          result.removedExternally++;
          continue;
        }
        if (current.etag !== entry.assoc.etag) continue; // Monica changed it; keep her version
        const base = appointmentEvent(entry.item, deps.accountAddress(entry.item.accountId), connection.timeZone);
        const event = key ? withConflicts(base, overlaps.map((o) => o.item)) : base;
        const updated = await calendar.patchEvent(entry.assoc.calendarId, entry.assoc.eventId, {
          summary: event.summary,
          description: event.description,
        });
        save({ ...entry.assoc, etag: updated.etag, conflictKey: key });
        if (key) result.conflictsMarked++;
        else result.conflictsCleared++;
      } catch {
        result.failed++;
      }
    }
  }

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
      if (contentChanged && existing.flaggedFingerprint !== fingerprint) {
        save({ ...existing, flaggedFingerprint: fingerprint });
        result.manualEditConflicts++;
      }
      return existing.eventId;
    }
    const patch: Partial<EventInput> = contentChanged
      ? { summary: event.summary, description: event.description, start: event.start, end: event.end }
      : { start: event.start, end: event.end };
    const updated = await calendar.patchEvent(existing.calendarId, existing.eventId, patch);
    // Rewritten content drops any conflict marking; markConflicts adds it back if still needed.
    save({
      ...existing,
      appliedFingerprint: fingerprint,
      etag: updated.etag,
      eventDate,
      conflictKey: contentChanged ? null : existing.conflictKey,
    });
    if (dateChanged && !contentChanged) result.followUpsMoved++;
    else result.updated++;
    return existing.eventId;
  }
}
