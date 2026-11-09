import { fetchJson, HttpError, type FetchLike } from '../ingestion/http';

// Google Calendar API v3, limited to what the dedicated calendar needs. Every
// write passes sendUpdates=none and no attendees, so nobody is ever invited
// or emailed (PRD F05).

const API = 'https://www.googleapis.com/calendar/v3';

/** Marks App-owned events with the scheduling item they belong to. */
export const ITEM_PROPERTY = 'assistantItemId';

export interface CalendarInfo {
  id: string;
  summary: string;
  timeZone: string;
}

export type EventTime = { dateTime: string; timeZone: string } | { date: string };

export interface EventInput {
  summary: string;
  description: string;
  start: EventTime;
  end: EventTime;
  /** 'transparent' does not block time (follow-ups); 'opaque' does. */
  transparency: 'opaque' | 'transparent';
  colorId?: string;
  itemId: string;
}

export interface CalendarEvent {
  id: string;
  etag: string;
  status?: string;
}

export class CalendarClient {
  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(API + path);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return fetchJson<T>(this.fetchImpl, url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  getCalendar(calendarId: string): Promise<CalendarInfo> {
    return this.request('GET', `/calendars/${encodeURIComponent(calendarId)}`);
  }

  createCalendar(summary: string, description: string, timeZone: string): Promise<CalendarInfo> {
    return this.request('POST', '/calendars', { summary, description, timeZone });
  }

  /** Finds an App event for an item, used to reconcile a write whose result was lost. */
  async findByItem(calendarId: string, itemId: string): Promise<CalendarEvent | null> {
    const result = await this.request<{ items?: CalendarEvent[] }>(
      'GET',
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      undefined,
      { privateExtendedProperty: `${ITEM_PROPERTY}=${itemId}`, showDeleted: 'false', maxResults: '5' },
    );
    return result.items?.find((e) => e.status !== 'cancelled') ?? null;
  }

  insertEvent(calendarId: string, event: EventInput): Promise<CalendarEvent> {
    return this.request('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, toBody(event), {
      sendUpdates: 'none',
    });
  }

  /** Returns null when the event no longer exists (deleted outside the App). */
  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent | null> {
    try {
      const event = await this.request<CalendarEvent>(
        'GET',
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      );
      return event.status === 'cancelled' ? null : event;
    } catch (error) {
      if (error instanceof HttpError && (error.status === 404 || error.status === 410)) return null;
      throw error;
    }
  }

  patchEvent(calendarId: string, eventId: string, patch: Partial<EventInput>): Promise<CalendarEvent> {
    const body: Record<string, unknown> = {};
    if (patch.summary !== undefined) body.summary = patch.summary;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.start) body.start = patch.start;
    if (patch.end) body.end = patch.end;
    return this.request(
      'PATCH',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      body,
      { sendUpdates: 'none' },
    );
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    const url = new URL(`${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    url.searchParams.set('sendUpdates', 'none');
    const response = await this.fetchImpl(url.toString(), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
    });
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new HttpError(response.status, url.toString());
    }
  }
}

function toBody(event: EventInput): Record<string, unknown> {
  return {
    summary: event.summary,
    description: event.description,
    start: event.start,
    end: event.end,
    transparency: event.transparency,
    ...(event.colorId ? { colorId: event.colorId } : {}),
    visibility: 'private',
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { [ITEM_PROPERTY]: event.itemId } },
  };
}

/** Link that opens Google Calendar with the dedicated calendar shown. */
export function calendarViewUrl(calendarId: string, googleAccount: string): string {
  const url = new URL('https://calendar.google.com/calendar/u/0/r');
  url.searchParams.set('cid', Buffer.from(calendarId).toString('base64').replace(/=+$/, ''));
  url.searchParams.set('authuser', googleAccount);
  return url.toString();
}
