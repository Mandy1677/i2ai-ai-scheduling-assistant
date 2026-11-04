import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  extractBodyText,
  GmailAdapter,
  htmlToText,
  parseGmailMessage,
  rangeQuery,
  splitAddressList,
} from './gmail-adapter';
import {
  authorize,
  AuthorizationCanceledError,
  buildAuthUrl,
  ClientConfigError,
  GoogleAccessTokenSource,
  loadClientConfig,
  pkcePair,
  type GoogleClientConfig,
} from './google-oauth';
import { fetchJson, HttpError, type FetchLike } from './http';

const b64 = (text: string): string => Buffer.from(text).toString('base64url');
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const client: GoogleClientConfig = {
  clientId: 'test-client.apps.googleusercontent.com',
  clientSecret: 'test-secret',
  authUri: 'https://accounts.google.com/o/oauth2/auth',
  tokenUri: 'https://oauth2.googleapis.com/token',
};

const tempDir = mkdtempSync(path.join(tmpdir(), 'assistant-ingestion-test-'));
after(() => rmSync(tempDir, { recursive: true, force: true }));

describe('http', () => {
  test('retries rate limits with backoff, then succeeds', async () => {
    const statuses = [429, 503, 200];
    const delays: number[] = [];
    const fake: FetchLike = async () => (statuses.length > 1 ? json({}, statuses.shift()) : json({ ok: 1 }));
    const result = await fetchJson<{ ok: number }>(fake, 'https://example.test/x', {}, {
      sleep: async (ms) => void delays.push(ms),
    });
    assert.deepEqual(result, { ok: 1 });
    assert.deepEqual(delays, [500, 1000]);
  });

  test('does not retry client errors and keeps body content out of the message', async () => {
    let calls = 0;
    const fake: FetchLike = async () => {
      calls++;
      return json({ error: 'invalid_grant', error_description: 'secret mail text' }, 400);
    };
    await assert.rejects(fetchJson(fake, 'https://oauth2.googleapis.com/token'), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.code, 'invalid_grant');
      assert.ok(!error.message.includes('secret mail text'));
      return true;
    });
    assert.equal(calls, 1);
  });
});

describe('google oauth', () => {
  test('loads a Desktop-app client file and rejects missing or invalid ones', () => {
    const good = path.join(tempDir, 'good.json');
    writeFileSync(
      good,
      JSON.stringify({
        installed: {
          client_id: client.clientId,
          client_secret: client.clientSecret,
          auth_uri: client.authUri,
          token_uri: client.tokenUri,
        },
      }),
    );
    assert.deepEqual(loadClientConfig(good), client);

    assert.throws(() => loadClientConfig(path.join(tempDir, 'nope.json')), (e: unknown) => {
      return e instanceof ClientConfigError && e.reason === 'missing';
    });
    const web = path.join(tempDir, 'web.json');
    writeFileSync(web, JSON.stringify({ web: { client_id: client.clientId } }));
    assert.throws(() => loadClientConfig(web), ClientConfigError);
    const evil = path.join(tempDir, 'evil.json');
    writeFileSync(
      evil,
      JSON.stringify({ installed: { client_id: client.clientId, client_secret: 's', token_uri: 'https://evil.test/token' } }),
    );
    assert.throws(() => loadClientConfig(evil), ClientConfigError);
  });

  test('builds an offline, PKCE auth URL with the read-only scope', () => {
    const { verifier, challenge } = pkcePair();
    assert.notEqual(verifier, challenge);
    const url = new URL(
      buildAuthUrl(client, {
        redirectUri: 'http://127.0.0.1:5555',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        state: 'st',
        codeChallenge: challenge,
        loginHint: 'a@example.com',
      }),
    );
    assert.equal(url.host, 'accounts.google.com');
    const p = url.searchParams;
    assert.equal(p.get('code_challenge_method'), 'S256');
    assert.equal(p.get('access_type'), 'offline');
    assert.equal(p.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
    assert.equal(p.get('login_hint'), 'a@example.com');
  });

  test('completes the loopback flow and exchanges the code with the PKCE verifier', async () => {
    let tokenRequest: URLSearchParams | null = null;
    const fake: FetchLike = async (url, init) => {
      assert.equal(url, client.tokenUri);
      tokenRequest = new URLSearchParams(init?.body as URLSearchParams);
      return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'scope-a scope-b' });
    };
    const tokens = await authorize({
      client,
      scopes: ['scope-a'],
      fetchImpl: fake,
      openBrowser: async (authUrl) => {
        const params = new URL(authUrl).searchParams;
        const redirect = new URL(params.get('redirect_uri')!);
        assert.equal(redirect.hostname, '127.0.0.1');
        // A stray request with the wrong state is ignored.
        const stray = await fetch(`${redirect.origin}/?code=x&state=wrong`);
        assert.equal(stray.status, 404);
        const page = await fetch(`${redirect.origin}/?code=auth-code&state=${params.get('state')}`);
        assert.match(await page.text(), /sign-in is complete/);
      },
    });
    assert.equal(tokens.refreshToken, 'rt');
    assert.deepEqual(tokens.scopes, ['scope-a', 'scope-b']);
    assert.equal(tokenRequest!.get('code'), 'auth-code');
    assert.equal(tokenRequest!.get('grant_type'), 'authorization_code');
    assert.ok(tokenRequest!.get('code_verifier'));
  });

  test('reports a denied consent as canceled', async () => {
    await assert.rejects(
      authorize({
        client,
        scopes: ['scope-a'],
        fetchImpl: async () => assert.fail('no token exchange after denial'),
        openBrowser: async (authUrl) => {
          const params = new URL(authUrl).searchParams;
          const redirect = new URL(params.get('redirect_uri')!);
          await fetch(`${redirect.origin}/?error=access_denied&state=${params.get('state')}`);
        },
      }),
      (error: unknown) => error instanceof AuthorizationCanceledError && error.code === 'access_denied',
    );
  });

  test('times out when the browser never returns', async () => {
    await assert.rejects(
      authorize({ client, scopes: ['s'], timeoutMs: 50, openBrowser: async () => undefined }),
      /timed out/,
    );
  });

  test('caches access tokens until shortly before expiry', async () => {
    let now = 0;
    let refreshes = 0;
    const fake: FetchLike = async () => json({ access_token: `at-${++refreshes}`, expires_in: 3600 });
    const source = new GoogleAccessTokenSource(client, 'rt', fake, () => now);
    assert.equal(await source.get(), 'at-1');
    now = 3000 * 1000;
    assert.equal(await source.get(), 'at-1');
    now = 3550 * 1000;
    assert.equal(await source.get(), 'at-2');
  });
});

describe('gmail parsing', () => {
  test('builds date queries for each history range', () => {
    const now = new Date(2026, 10, 4, 12, 0, 0);
    assert.equal(rangeQuery({ mode: 'all-history', fromDate: null }, now), undefined);
    assert.equal(
      rangeQuery({ mode: 'last-30-days', fromDate: null }, now),
      `after:${Math.floor((now.getTime() - 30 * 86400000) / 1000)}`,
    );
    assert.equal(
      rangeQuery({ mode: 'from-date', fromDate: '2026-10-01' }, now),
      `after:${Math.floor(new Date(2026, 9, 1).getTime() / 1000)}`,
    );
  });

  test('splits address lists without breaking quoted names', () => {
    assert.deepEqual(splitAddressList('"Doe, Jane" <jane@example.com>, bob@example.com'), [
      '"Doe, Jane" <jane@example.com>',
      'bob@example.com',
    ]);
    assert.deepEqual(splitAddressList(null), []);
  });

  test('prefers text/plain, skips attachments, and falls back to HTML', () => {
    const multipart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('Can we meet Tuesday at 3?') } },
            { mimeType: 'text/html', body: { data: b64('<p>Can we meet <b>Tuesday</b>?</p>') } },
          ],
        },
        { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64('attachment text') } },
      ],
    };
    assert.equal(extractBodyText(multipart), 'Can we meet Tuesday at 3?');
    const htmlOnly = { mimeType: 'text/html', body: { data: b64('<style>x{}</style><p>Hi&nbsp;there</p><p>Bye</p>') } };
    assert.equal(extractBodyText(htmlOnly), 'Hi there\nBye');
    assert.equal(htmlToText('a<br>b &amp; c'), 'a\nb & c');
  });

  test('normalizes headers, receipt time, and thread identity', () => {
    const message = parseGmailMessage('acct-1', {
      id: 'm1',
      threadId: 't1',
      internalDate: String(Date.UTC(2026, 10, 3, 15, 0)),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'Pat <pat@example.com>' },
          { name: 'To', value: 'me@example.com' },
          { name: 'Subject', value: 'Reschedule' },
          { name: 'Message-ID', value: '<abc@example.com>' },
        ],
        body: { data: b64('I need to reschedule.') },
      },
    });
    assert.deepEqual(message, {
      accountId: 'acct-1',
      providerMessageId: 'm1',
      threadId: 't1',
      receivedAt: '2026-11-03T15:00:00.000Z',
      from: 'Pat <pat@example.com>',
      to: ['me@example.com'],
      cc: [],
      subject: 'Reschedule',
      internetMessageId: '<abc@example.com>',
      bodyText: 'I need to reschedule.',
    });
  });
});

describe('gmail adapter', () => {
  type Call = { url: URL; method: string; auth: string | null };
  function fakeGmail(routes: (url: URL) => Response): { fetchImpl: FetchLike; calls: Call[] } {
    const calls: Call[] = [];
    return {
      calls,
      fetchImpl: async (input, init) => {
        const url = new URL(input);
        const headers = new Headers(init?.headers);
        calls.push({ url, method: init?.method ?? 'GET', auth: headers.get('Authorization') });
        return routes(url);
      },
    };
  }

  test('lists the initial range page by page using only GET requests', async () => {
    const { fetchImpl, calls } = fakeGmail((url) =>
      url.searchParams.get('pageToken')
        ? json({ messages: [{ id: 'm3', threadId: 't3' }] })
        : json({ messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }], nextPageToken: 'p2' }),
    );
    const adapter = new GmailAdapter('acct', 'INBOX', async () => 'token', fetchImpl);
    const first = await adapter.listInitial({ mode: 'all-history', fromDate: null }, null);
    assert.deepEqual(first.refs.map((r) => r.providerMessageId), ['m1', 'm2']);
    assert.equal(first.nextPageToken, 'p2');
    const second = await adapter.listInitial({ mode: 'all-history', fromDate: null }, 'p2');
    assert.deepEqual(second.refs.map((r) => r.providerMessageId), ['m3']);
    assert.equal(second.nextPageToken, null);
    assert.ok(calls.every((c) => c.method === 'GET' && c.auth === 'Bearer token'));
    assert.equal(calls[0].url.pathname, '/gmail/v1/users/me/messages');
    assert.equal(calls[0].url.searchParams.get('labelIds'), 'INBOX');
    assert.equal(calls[0].url.searchParams.get('q'), null);
  });

  test('collects added messages across history pages without duplicates', async () => {
    const { fetchImpl } = fakeGmail((url) =>
      url.searchParams.get('pageToken')
        ? json({ historyId: '200', history: [{ messagesAdded: [{ message: { id: 'm2' } }] }] })
        : json({
            historyId: '150',
            nextPageToken: 'h2',
            history: [
              { messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] },
              { messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] },
            ],
          }),
    );
    const adapter = new GmailAdapter('acct', 'INBOX', async () => 'token', fetchImpl);
    const result = await adapter.listChanges('100');
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
      assert.deepEqual(result.refs.map((r) => r.providerMessageId), ['m1', 'm2']);
      assert.equal(result.cursor, '200');
    }
  });

  test('reports an expired history cursor instead of claiming no changes', async () => {
    const { fetchImpl } = fakeGmail(() => json({ error: { status: 'NOT_FOUND' } }, 404));
    const adapter = new GmailAdapter('acct', 'INBOX', async () => 'token', fetchImpl);
    assert.deepEqual(await adapter.listChanges('1'), { status: 'cursor-expired' });
  });

  test('fetches a full message with format=full', async () => {
    const { fetchImpl, calls } = fakeGmail(() =>
      json({ id: 'm1', threadId: 't1', payload: { mimeType: 'text/plain', body: { data: b64('hello') } } }),
    );
    const adapter = new GmailAdapter('acct', 'INBOX', async () => 'token', fetchImpl);
    const message = await adapter.fetchMessage({
      accountId: 'acct',
      providerMessageId: 'm1',
      threadId: 't1',
      receivedAt: null,
    });
    assert.equal(message.bodyText, 'hello');
    assert.equal(calls[0].url.searchParams.get('format'), 'full');
  });
});
