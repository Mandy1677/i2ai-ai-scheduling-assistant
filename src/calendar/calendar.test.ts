import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import type { SchedulingAnalysis } from '../analysis/validation';
import type { FetchLike } from '../ingestion/http';
import { AccountStore } from '../storage/account-store';
import { CalendarStore } from '../storage/calendar-store';
import { openDatabase } from '../storage/database';
import { ProcessingStore } from '../storage/processing-store';
import { SchedulingStore } from '../storage/scheduling-store';
import { SecretStore } from '../storage/secret-store';
import { SettingKey, SettingsStore } from '../storage/settings-store';
import { fakeEncryptor } from '../storage/test-helpers';
import { applyToCalendar, dateInZone, restoreText } from './apply';
import { CalendarClient, calendarViewUrl, ITEM_PROPERTY } from './calendar-client';
import { CALENDAR_SCOPE, CalendarConnector } from './calendar-connector';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface StoredEvent {
  id: string;
  etag: string;
  body: Record<string, any>;
}

/** In-memory Google Calendar API covering the endpoints the App uses. */
class FakeCalendarApi {
  calendars = new Map<string, { id: string; summary: string; timeZone: string }>();
  events = new Map<string, StoredEvent>();
  writes: { method: string; url: URL; body: any }[] = [];
  private seq = 0;

  fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') this.writes.push({ method, url, body });
    const parts = url.pathname.replace('/calendar/v3/', '').split('/').map(decodeURIComponent);
    if (parts[0] === 'calendars' && parts.length === 1 && method === 'POST') {
      const cal = { id: `cal-${++this.seq}@group.calendar.google.com`, summary: body.summary, timeZone: body.timeZone };
      this.calendars.set(cal.id, cal);
      return json(cal);
    }
    if (parts[0] === 'calendars' && parts.length === 2) {
      const cal = this.calendars.get(parts[1]);
      return cal ? json(cal) : json({ error: { status: 'NOT_FOUND' } }, 404);
    }
    if (parts[2] === 'events' && parts.length === 3 && method === 'GET') {
      const [, want] = (url.searchParams.get('privateExtendedProperty') ?? '=').split('=');
      return json({ items: [...this.events.values()].filter((e) => e.body.extendedProperties?.private?.[ITEM_PROPERTY] === want).map((e) => ({ id: e.id, etag: e.etag })) });
    }
    if (parts[2] === 'events' && parts.length === 3 && method === 'POST') {
      const event = { id: `ev-${++this.seq}`, etag: `"e${this.seq}"`, body };
      this.events.set(event.id, event);
      return json({ id: event.id, etag: event.etag });
    }
    const event = this.events.get(parts[3]);
    if (!event) return json({ error: { status: 'NOT_FOUND' } }, 404);
    if (method === 'GET') return json({ id: event.id, etag: event.etag });
    if (method === 'PATCH') {
      Object.assign(event.body, body);
      event.etag = `"e${++this.seq}"`;
      return json({ id: event.id, etag: event.etag });
    }
    if (method === 'DELETE') {
      this.events.delete(event.id);
      return new Response(null, { status: 204 });
    }
    return json({}, 400);
  };

  /** Simulates Monica editing an event in Google Calendar. */
  editByUser(id: string): void {
    this.events.get(id)!.etag = `"user-${++this.seq}"`;
  }
}

const baseAnalysis = (overrides: Partial<SchedulingAnalysis>): SchedulingAnalysis => ({
  requestType: 'scheduling-request',
  category: 'patient',
  summary: '[PERSON_1] asks [CLINICIAN] for a time next week.',
  timing: { start: null, end: null, durationMinutes: null, timeZone: null, window: 'next week', agreementEvidence: null },
  urgency: { explicit: false, deadline: null, evidence: null },
  existingMeetingReference: null,
  evidence: [],
  reviewNotes: [],
  ...overrides,
});

const CONFIRMED_TIMING = {
  start: '2026-11-12T14:00',
  end: '2026-11-12T14:50',
  durationMinutes: 50,
  timeZone: 'America/New_York',
  window: null,
  agreementEvidence: 'confirming our session',
};

function setup() {
  const db = openDatabase(':memory:');
  const accounts = new AccountStore(db);
  const accountId = accounts.add({ address: 'owner@gmail.com', provider: 'gmail', imap: null, credentialSecretId: null });
  const queue = new ProcessingStore(db);
  const store = new SchedulingStore(db);
  const associations = new CalendarStore(db);
  const api = new FakeCalendarApi();
  // Indirect so tests can swap api.fetch to inject failures.
  const calendar = new CalendarClient(async () => 'token', (input, init) => api.fetch(input, init));
  const connection = { googleAccount: 'owner@gmail.com', calendarId: 'cal-dedicated', calendarName: 'AI Scheduling Assistant', timeZone: 'America/New_York' };
  let n = 0;
  const addItem = (analysis: SchedulingAnalysis, opts: { thread?: string; receivedAt?: string; aliases?: Record<string, string> } = {}) => {
    const messageId = `m${++n}`;
    queue.enqueue([{ accountId, providerMessageId: messageId, threadId: opts.thread ?? `t${n}`, receivedAt: null }], '2026-11-04T00:00:00Z');
    const processing = queue.due(['queued'], '9999', 100).find((i) => i.providerMessageId === messageId)!;
    queue.setStage(processing.id, 'analyzed', '2026-11-04T00:00:00Z');
    return store.save(analysis, {
      processingItemId: processing.id,
      receivedAt: opts.receivedAt ?? '2026-11-04T15:00:00.000Z',
      sourceKey: `${accountId}:${messageId}`,
      promptVersion: 'v1',
      model: 'm',
      redactionFailed: false,
      aliases: opts.aliases ?? { '[PERSON_1]': 'Sam' },
      now: '2026-11-04T15:00:00Z',
    });
  };
  let now = new Date('2026-11-04T17:00:00Z'); // Nov 4, noon in New York
  const run = () =>
    applyToCalendar({ store, associations, calendar, connection, accountAddress: () => 'owner@gmail.com', clock: () => now });
  const setNow = (iso: string) => (now = new Date(iso));
  return { db, api, addItem, run, setNow, associations };
}

describe('confirmed appointments (T012)', () => {
  test('writes one timed event at the agreed time, with no invitations, and is idempotent', async () => {
    const { api, addItem, run } = setup();
    addItem(baseAnalysis({ requestType: 'confirmed-appointment', summary: '[PERSON_1] confirms a session with [CLINICIAN].', timing: CONFIRMED_TIMING }));
    assert.equal((await run()).created, 1);
    assert.equal((await run()).unchanged, 1);
    assert.equal(api.events.size, 1);

    const [event] = [...api.events.values()];
    assert.deepEqual(event.body.start, { dateTime: '2026-11-12T14:00:00', timeZone: 'America/New_York' });
    assert.deepEqual(event.body.end, { dateTime: '2026-11-12T14:50:00', timeZone: 'America/New_York' });
    assert.equal(event.body.transparency, 'opaque');
    assert.equal(event.body.attendees, undefined);
    assert.equal(event.body.summary, 'P1 Patient: Sam confirms a session with you.');
    assert.match(event.body.description, /Source email: https:\/\/mail\.google\.com/);
    assert.ok(api.writes.every((w) => w.method === 'DELETE' || w.url.searchParams.get('sendUpdates') === 'none'));
  });

  test('adopts an event created by an earlier attempt whose result was lost', async () => {
    const { api, addItem, run } = setup();
    const itemId = addItem(baseAnalysis({ requestType: 'confirmed-appointment', timing: CONFIRMED_TIMING }));
    api.events.set('ev-lost', { id: 'ev-lost', etag: '"x"', body: { extendedProperties: { private: { [ITEM_PROPERTY]: itemId } } } });
    const result = await run();
    assert.equal(result.created, 0);
    assert.equal(api.events.size, 1);
  });

  test('the same appointment from two messages in a conversation becomes one event', async () => {
    const { api, addItem, run } = setup();
    addItem(baseAnalysis({ requestType: 'confirmed-appointment', timing: CONFIRMED_TIMING }), { thread: 'shared' });
    addItem(baseAnalysis({ requestType: 'confirmed-appointment', summary: 'Confirmed again.', timing: CONFIRMED_TIMING }), { thread: 'shared' });
    const result = await run();
    assert.equal(result.created, 1);
    assert.equal(result.linkedDuplicates, 1);
    assert.equal(api.events.size, 1);
    assert.equal((await run()).created, 0);
  });

  test('keeps an appointment Monica edited in Google Calendar', async () => {
    const { api, addItem, run, db } = setup();
    const itemId = addItem(baseAnalysis({ requestType: 'confirmed-appointment', timing: CONFIRMED_TIMING }));
    await run();
    const [event] = [...api.events.values()];
    api.editByUser(event.id);
    db.prepare('UPDATE scheduling_items SET summary = ? WHERE id = ?').run('[PERSON_1] confirmed (re-analyzed).', itemId);
    const result = await run();
    assert.equal(result.keptManualEdits, 1);
    assert.equal(result.updated, 0);
  });
});

describe('follow-ups (T013)', () => {
  test('unresolved requests become all-day, non-blocking Follow up entries', async () => {
    const { api, addItem, run } = setup();
    addItem(baseAnalysis({ requestType: 'reschedule-request', summary: '[PERSON_1] asks to reschedule; [HEALTH_DETAIL] conflicts.' }));
    addItem(baseAnalysis({ requestType: 'non-scheduling', category: null, summary: 'Newsletter.' }));
    const result = await run();
    assert.equal(result.created, 1);
    assert.equal(result.skipped, 1);
    const [event] = [...api.events.values()];
    assert.deepEqual(event.body.start, { date: '2026-11-04' });
    assert.deepEqual(event.body.end, { date: '2026-11-05' });
    assert.equal(event.body.transparency, 'transparent');
    assert.equal(event.body.colorId, '5');
    assert.equal(event.body.summary, 'Follow up · P1 Patient: Sam asks to reschedule; another appointment conflicts.');
  });

  test('carries an unfinished follow-up to the next day as the same entry', async () => {
    const { api, addItem, run, setNow } = setup();
    addItem(baseAnalysis({}));
    await run();
    setNow('2026-11-06T15:00:00Z');
    const result = await run();
    assert.equal(result.followUpsMoved, 1);
    assert.equal(api.events.size, 1);
    assert.deepEqual([...api.events.values()][0].body.start, { date: '2026-11-06' });
  });

  test('old pending requests appear on today, not stranded in the past', async () => {
    const { api, addItem, run } = setup();
    addItem(baseAnalysis({}), { receivedAt: '2026-10-01T12:00:00Z' });
    await run();
    assert.deepEqual([...api.events.values()][0].body.start, { date: '2026-11-04' });
  });

  test('a later confirmation in the same conversation resolves the follow-up', async () => {
    const { api, addItem, run } = setup();
    addItem(baseAnalysis({}), { thread: 'alex', receivedAt: '2026-11-04T15:40:00Z' });
    await run();
    assert.equal(api.events.size, 1);
    addItem(baseAnalysis({ requestType: 'confirmed-appointment', timing: CONFIRMED_TIMING }), { thread: 'alex', receivedAt: '2026-11-04T15:48:00Z' });
    const result = await run();
    assert.equal(result.resolved, 1);
    assert.equal(result.created, 1);
    assert.equal(api.events.size, 1);
    assert.equal([...api.events.values()][0].body.transparency, 'opaque');
  });

  test('a follow-up deleted in Google Calendar is never recreated', async () => {
    const { api, addItem, run, setNow } = setup();
    addItem(baseAnalysis({}));
    await run();
    api.events.clear();
    setNow('2026-11-05T15:00:00Z');
    assert.equal((await run()).removedExternally, 1);
    setNow('2026-11-06T15:00:00Z');
    const later = await run();
    assert.equal(later.created, 0);
    assert.equal(api.events.size, 0);
  });

  test('one failing write does not stop other items', async () => {
    const { api, addItem, run } = setup();
    addItem(baseAnalysis({}));
    addItem(baseAnalysis({ requestType: 'confirmed-appointment', timing: CONFIRMED_TIMING }));
    const original = api.fetch;
    let first = true;
    api.fetch = async (input, init) => {
      if ((init?.method ?? 'GET') === 'POST' && first) {
        first = false;
        return json({ error: { status: 'INVALID' } }, 400);
      }
      return original(input, init);
    };
    const result = await run();
    assert.equal(result.failed, 1);
    assert.equal(result.created, 1);
    // The failed item is retried on the next run and succeeds.
    assert.equal((await run()).created, 1);
  });
});

describe('calendar helpers', () => {
  test('restores names locally and turns other placeholders into words', () => {
    assert.equal(
      restoreText('[PERSON_1] and [THRIVEWORKS_PR_CONTACT] asked [CLINICIAN]; [EDUCATIONAL_SENDER] too.', { '[PERSON_1]': 'Sam' }),
      'Sam and Jennifer (Thriveworks PR) asked you; educational sender too.',
    );
  });

  test('dates follow the calendar time zone', () => {
    assert.equal(dateInZone(new Date('2026-11-05T03:00:00Z'), 'America/New_York'), '2026-11-04');
    assert.equal(dateInZone(new Date('2026-11-05T03:00:00Z'), 'UTC'), '2026-11-05');
  });

  test('open link points at the dedicated calendar for the right account', () => {
    const url = new URL(calendarViewUrl('abc@group.calendar.google.com', 'owner@gmail.com'));
    assert.equal(url.host, 'calendar.google.com');
    assert.equal(Buffer.from(url.searchParams.get('cid')!, 'base64').toString(), 'abc@group.calendar.google.com');
    assert.equal(url.searchParams.get('authuser'), 'owner@gmail.com');
  });
});

describe('calendar connection (T011)', () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'assistant-calendar-test-'));
  after(() => rmSync(tempDir, { recursive: true, force: true }));
  const clientPath = path.join(tempDir, 'google-oauth-client.json');
  writeFileSync(
    clientPath,
    JSON.stringify({ installed: { client_id: 'c.apps.googleusercontent.com', client_secret: 's', token_uri: 'https://oauth2.googleapis.com/token' } }),
  );

  function connectorSetup(scope = `${CALENDAR_SCOPE} openid email`) {
    const db = openDatabase(':memory:');
    const stores = { settings: new SettingsStore(db), secrets: new SecretStore(db, fakeEncryptor()), accounts: new AccountStore(db) };
    const api = new FakeCalendarApi();
    const fetchImpl: FetchLike = async (url, init) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope });
      }
      if (url === 'https://oauth2.googleapis.com/revoke') return new Response(null, { status: 200 });
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return json({ email: 'Owner@gmail.com' });
      return api.fetch(url, init);
    };
    const connector = new CalendarConnector({
      stores,
      clientConfigPath: clientPath,
      defaultTimeZone: 'America/New_York',
      fetchImpl,
      openBrowser: async (authUrl) => {
        const params = new URL(authUrl).searchParams;
        assert.ok(params.get('scope')!.includes(CALENDAR_SCOPE));
        const redirect = new URL(params.get('redirect_uri')!);
        await fetch(`${redirect.origin}/?code=c&state=${params.get('state')}`);
      },
    });
    return { stores, api, connector };
  }

  test('creates the dedicated calendar once and reuses it on reconnect', async () => {
    const { stores, api, connector } = connectorSetup();
    assert.deepEqual(await connector.connect(), { status: 'connected' });
    const first = stores.settings.get<{ calendarId: string; googleAccount: string; timeZone: string }>(SettingKey.calendar)!;
    assert.equal(first.googleAccount, 'owner@gmail.com');
    assert.equal(first.timeZone, 'America/New_York');
    assert.equal(stores.secrets.read(stores.settings.get<string>(SettingKey.calendarSecretId)!), 'rt');

    await connector.connect();
    const second = stores.settings.get<{ calendarId: string }>(SettingKey.calendar)!;
    assert.equal(second.calendarId, first.calendarId);
    assert.equal(api.calendars.size, 1);
    assert.ok(connector.client());
  });

  test('refuses a sign-in without calendar access', async () => {
    const { stores, connector } = connectorSetup('openid email');
    const outcome = await connector.connect();
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') assert.match(outcome.failure.message, /Calendar access was not granted/);
    assert.equal(stores.settings.get(SettingKey.calendar), null);
  });
});
