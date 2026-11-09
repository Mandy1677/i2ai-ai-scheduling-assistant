import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { AccountStore } from './account-store';
import { isConfigured, missingConfiguration } from './config-status';
import { openDatabase } from './database';
import { SCHEMA_VERSION } from './migrations';
import { SecretStore, SecureStorageUnavailableError } from './secret-store';
import { SettingKey, SettingsStore } from './settings-store';
import { fakeEncryptor } from './test-helpers';

const tempDir = mkdtempSync(path.join(tmpdir(), 'assistant-storage-test-'));
after(() => rmSync(tempDir, { recursive: true, force: true }));
let dbCounter = 0;
const tempDbPath = (): string => path.join(tempDir, `test-${dbCounter++}.sqlite`);

describe('database', () => {
  test('migrates a fresh database and reopening is a no-op', () => {
    const file = tempDbPath();
    const db = openDatabase(file);
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(version.user_version, SCHEMA_VERSION);
    db.close();

    const reopened = openDatabase(file);
    const tables = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    assert.deepEqual(tables, [
      'accounts',
      'calendar_associations',
      'processing_items',
      'scheduling_item_sources',
      'scheduling_items',
      'secrets',
      'settings',
      'sync_cursors',
    ]);
    reopened.close();
  });

  test('no table has a column for email bodies', () => {
    const db = openDatabase(':memory:');
    const columns = db
      .prepare("SELECT p.name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    assert.ok(!columns.some((name) => /body|content/i.test(name)), columns.join(','));
    db.close();
  });

  test('rejects the same source message twice for one account', () => {
    const db = openDatabase(':memory:');
    const accounts = new AccountStore(db);
    const id = accounts.add({ address: 'a@example.com', provider: 'gmail', imap: null, credentialSecretId: null });
    const insert = db.prepare(
      "INSERT INTO processing_items (id, account_id, source_message_id, stage, updated_at) VALUES (?, ?, 'msg-1', 'queued', 'now')",
    );
    insert.run('p1', id);
    assert.throws(() => insert.run('p2', id), /UNIQUE/);
    db.close();
  });
});

describe('settings store', () => {
  test('values survive reopening the database', () => {
    const file = tempDbPath();
    const db = openDatabase(file);
    new SettingsStore(db).set(SettingKey.historyRange, { mode: 'last-30-days', fromDate: null });
    db.close();

    const reopened = openDatabase(file);
    assert.deepEqual(new SettingsStore(reopened).get(SettingKey.historyRange), {
      mode: 'last-30-days',
      fromDate: null,
    });
    reopened.close();
  });
});

describe('secret store', () => {
  test('stores ciphertext only and reads back the original', () => {
    const db = openDatabase(':memory:');
    const secrets = new SecretStore(db, fakeEncryptor());
    const id = secrets.save('sk-test-value');
    const row = db.prepare('SELECT ciphertext FROM secrets WHERE id = ?').get(id) as { ciphertext: Uint8Array };
    assert.ok(!Buffer.from(row.ciphertext).toString().includes('sk-test-value'));
    assert.equal(secrets.read(id), 'sk-test-value');
    assert.ok(secrets.has(id));
    secrets.delete(id);
    assert.ok(!secrets.has(id));
    db.close();
  });

  test('refuses to save when encryption is unavailable and writes nothing', () => {
    const db = openDatabase(':memory:');
    const secrets = new SecretStore(db, fakeEncryptor(false));
    assert.throws(() => secrets.save('sk-test-value'), SecureStorageUnavailableError);
    const count = db.prepare('SELECT COUNT(*) AS n FROM secrets').get() as { n: number };
    assert.equal(count.n, 0);
    db.close();
  });
});

describe('configuration status', () => {
  test('is incomplete until every required item exists', () => {
    const db = openDatabase(':memory:');
    const stores = {
      settings: new SettingsStore(db),
      secrets: new SecretStore(db, fakeEncryptor()),
      accounts: new AccountStore(db),
    };
    assert.equal(missingConfiguration(stores).length, 5);

    stores.settings.set(SettingKey.historyRange, { mode: 'all-history', fromDate: null });
    stores.settings.set(SettingKey.openRouterModel, 'vendor/model:free');
    stores.settings.set(SettingKey.openRouterKeySecretId, stores.secrets.save('sk-test'));
    stores.settings.set(SettingKey.calendar, { googleAccount: 'g', calendarId: 'c', calendarName: 'n' });
    const accountId = stores.accounts.add({
      address: 'a@example.com',
      provider: 'gmail',
      imap: null,
      credentialSecretId: null,
    });
    // An added but unconnected account does not count.
    assert.deepEqual(missingConfiguration(stores), ['a connected email account']);

    db.prepare("UPDATE accounts SET connection_state = 'connected' WHERE id = ?").run(accountId);
    assert.ok(isConfigured(stores));
    db.close();
  });
});
