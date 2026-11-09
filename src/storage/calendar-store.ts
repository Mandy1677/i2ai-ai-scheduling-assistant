import type { DatabaseSync } from 'node:sqlite';

// Links each scheduling item to the calendar entry the App made for it
// (ARCHITECTURE section 5, "Calendar association"). Completion is recorded
// only after the calendar API confirms the write.

export type EntryKind = 'appointment' | 'follow-up';

/**
 * active: the App manages the entry.
 * resolved: a follow-up that is no longer needed and was removed.
 * removed-externally: the entry was deleted in Google Calendar; never recreate it.
 * rescheduled: the event was moved by a confirmed reschedule, which now owns it.
 */
export type EntryState = 'active' | 'resolved' | 'removed-externally' | 'rescheduled';

export interface CalendarAssociation {
  schedulingItemId: string;
  calendarId: string;
  eventId: string;
  kind: EntryKind;
  appliedFingerprint: string;
  etag: string | null;
  state: EntryState;
  /** All-day date for follow-ups (YYYY-MM-DD). */
  eventDate: string | null;
  /** The overlaps last marked on this appointment, or null when none are marked. */
  conflictKey?: string | null;
  /** An email change already reported as conflicting with a manual edit. */
  flaggedFingerprint?: string | null;
}

interface Row {
  scheduling_item_id: string;
  calendar_id: string;
  event_id: string;
  kind: EntryKind;
  applied_fingerprint: string;
  last_known_etag: string | null;
  state: EntryState;
  event_date: string | null;
  conflict_key: string | null;
  flagged_fingerprint: string | null;
}

export class CalendarStore {
  constructor(private readonly db: DatabaseSync) {}

  get(schedulingItemId: string): CalendarAssociation | null {
    const row = this.db
      .prepare('SELECT * FROM calendar_associations WHERE scheduling_item_id = ?')
      .get(schedulingItemId) as Row | undefined;
    return row
      ? {
          schedulingItemId: row.scheduling_item_id,
          calendarId: row.calendar_id,
          eventId: row.event_id,
          kind: row.kind,
          appliedFingerprint: row.applied_fingerprint,
          etag: row.last_known_etag,
          state: row.state,
          eventDate: row.event_date,
          conflictKey: row.conflict_key,
          flaggedFingerprint: row.flagged_fingerprint,
        }
      : null;
  }

  save(association: CalendarAssociation, now: string): void {
    this.db
      .prepare(
        `INSERT INTO calendar_associations
           (scheduling_item_id, calendar_id, event_id, kind, applied_fingerprint, last_known_etag, state, event_date,
            conflict_key, flagged_fingerprint, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scheduling_item_id) DO UPDATE SET
           calendar_id = excluded.calendar_id, event_id = excluded.event_id, kind = excluded.kind,
           applied_fingerprint = excluded.applied_fingerprint, last_known_etag = excluded.last_known_etag,
           state = excluded.state, event_date = excluded.event_date, conflict_key = excluded.conflict_key,
           flagged_fingerprint = excluded.flagged_fingerprint, updated_at = excluded.updated_at`,
      )
      .run(
        association.schedulingItemId,
        association.calendarId,
        association.eventId,
        association.kind,
        association.appliedFingerprint,
        association.etag,
        association.state,
        association.eventDate,
        association.conflictKey ?? null,
        association.flaggedFingerprint ?? null,
        now,
      );
  }
}
