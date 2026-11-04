import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import type { FetchLike } from '../ingestion/http';
import { AccountStore } from '../storage/account-store';
import { openDatabase } from '../storage/database';
import { SecretStore } from '../storage/secret-store';
import { SettingsStore } from '../storage/settings-store';
import { fakeEncryptor } from '../storage/test-helpers';
import { AccountConnector } from './account-connector';

const tempDir = mkdtempSync(path.join(tmpdir(), 'assistant-connector-test-'));
after(() => rmSync(tempDir, { recursive: true, force: true }));
const clientPath = path.join(tempDir, 'google-oauth-client.json');
writeFileSync(
  clientPath,
  JSON.stringify({
    installed: {
      client_id: 'test-client.apps.googleusercontent.com',
      client_secret: 'test-secret',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
    },
  }),
);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function setup(options: { profileEmail?: string; scope?: string; deny?: boolean; clientConfigPath?: string } = {}) {
  const db = openDatabase(':memory:');
  const stores = {
    settings: new SettingsStore(db),
    secrets: new SecretStore(db, fakeEncryptor()),
    accounts: new AccountStore(db),
  };
  const accountId = stores.accounts.add({
    address: 'test.user@gmail.com',
    provider: 'gmail',
    imap: null,
    credentialSecretId: null,
  });
  const revoked: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      return json({ access_token: 'at', refresh_token: 'rt-new', expires_in: 3600, scope: options.scope ?? GMAIL_SCOPE });
    }
    if (url === 'https://oauth2.googleapis.com/revoke') {
      revoked.push(new URLSearchParams(init?.body as URLSearchParams).get('token')!);
      return new Response(null, { status: 200 });
    }
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/profile')) {
      return json({ emailAddress: options.profileEmail ?? 'Test.User@gmail.com', historyId: '42' });
    }
    throw new Error(`unexpected ${url}`);
  };
  const connector = new AccountConnector({
    stores,
    clientConfigPath: options.clientConfigPath ?? clientPath,
    fetchImpl,
    openBrowser: async (authUrl) => {
      const params = new URL(authUrl).searchParams;
      const redirect = new URL(params.get('redirect_uri')!);
      const result = options.deny ? 'error=access_denied' : 'code=c';
      await fetch(`${redirect.origin}/?${result}&state=${params.get('state')}`);
    },
  });
  return { db, stores, accountId, connector, revoked };
}

describe('account connector', () => {
  test('connects a Gmail account and stores the refresh token only as a secret', async () => {
    const { stores, accountId, connector, db } = setup();
    const outcome = await connector.connect(accountId);
    assert.deepEqual(outcome, { status: 'connected' });
    const account = stores.accounts.get(accountId)!;
    assert.equal(account.connectionState, 'connected');
    assert.equal(stores.secrets.read(account.credentialSecretId!), 'rt-new');
    const settingsRows = JSON.stringify(db.prepare('SELECT * FROM settings').all());
    assert.ok(!settingsRows.includes('rt-new'));
    assert.equal(stores.accounts.countConnected(), 1);
  });

  test('rejects and revokes a sign-in with a different Google account', async () => {
    const { stores, accountId, connector, revoked } = setup({ profileEmail: 'someone.else@gmail.com' });
    const outcome = await connector.connect(accountId);
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') assert.match(outcome.failure.message, /different Google account/);
    assert.equal(stores.accounts.get(accountId)!.connectionState, 'not-connected');
    assert.deepEqual(revoked, ['rt-new']);
  });

  test('rejects a sign-in where read access was unticked', async () => {
    const { accountId, connector, revoked } = setup({ scope: 'openid' });
    const outcome = await connector.connect(accountId);
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') assert.match(outcome.failure.message, /read access was not granted/);
    assert.deepEqual(revoked, ['rt-new']);
  });

  test('reports a canceled sign-in without changing the account', async () => {
    const { stores, accountId, connector } = setup({ deny: true });
    const outcome = await connector.connect(accountId);
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') assert.match(outcome.failure.message, /canceled or denied/);
    assert.equal(stores.accounts.get(accountId)!.connectionState, 'not-connected');
  });

  test('explains where to put a missing OAuth client file', async () => {
    const missing = path.join(tempDir, 'missing.json');
    const { accountId, connector } = setup({ clientConfigPath: missing });
    const outcome = await connector.connect(accountId);
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') {
      assert.equal(outcome.failure.id, 'google-client-config');
      assert.ok(outcome.failure.action.includes(missing));
    }
  });

  test('reconnecting replaces the old token and revoke uses the stored one', async () => {
    const { stores, accountId, connector, revoked } = setup();
    await connector.connect(accountId);
    const firstSecret = stores.accounts.get(accountId)!.credentialSecretId!;
    await connector.connect(accountId);
    const secondSecret = stores.accounts.get(accountId)!.credentialSecretId!;
    assert.notEqual(firstSecret, secondSecret);
    assert.ok(!stores.secrets.has(firstSecret));
    await connector.revoke(accountId);
    assert.deepEqual(revoked, ['rt-new']);
  });
});
