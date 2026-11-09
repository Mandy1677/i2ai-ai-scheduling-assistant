import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AccountStore } from '../storage/account-store';
import { openDatabase } from '../storage/database';
import { SecretStore } from '../storage/secret-store';
import { SettingKey, SettingsStore } from '../storage/settings-store';
import { fakeEncryptor } from '../storage/test-helpers';
import { isValidPastDate, SettingsService, validateSettingsInput } from './settings-service';

function makeService(encryptionAvailable = true) {
  const db = openDatabase(':memory:');
  const stores = {
    settings: new SettingsStore(db),
    secrets: new SecretStore(db, fakeEncryptor(encryptionAvailable)),
    accounts: new AccountStore(db),
  };
  return { db, stores, service: new SettingsService(stores) };
}

const validInput = {
  historyRange: { mode: 'last-30-days', fromDate: null },
  openRouterModel: 'vendor/model-name:free',
  openRouterApiKey: 'sk-or-test',
};

describe('settings validation', () => {
  test('requires an explicit history range', () => {
    const { errors } = validateSettingsInput({ ...validInput, historyRange: null });
    assert.ok(errors.historyRange);
  });

  test('requires a real, non-future date for "from a chosen date"', () => {
    const today = new Date(2026, 10, 4);
    assert.ok(isValidPastDate('2026-01-31', today));
    assert.ok(isValidPastDate('2026-11-04', today));
    assert.ok(!isValidPastDate('2026-02-30', today));
    assert.ok(!isValidPastDate('2026-11-05', today));
    assert.ok(!isValidPastDate('01/02/2026', today));
    const { errors } = validateSettingsInput(
      { ...validInput, historyRange: { mode: 'from-date', fromDate: '' } },
      today,
    );
    assert.ok(errors.fromDate);
  });

  test('rejects malformed input from the renderer', () => {
    const { errors } = validateSettingsInput('not an object');
    assert.ok(errors.historyRange);
    assert.ok(errors.openRouterModel);
  });
});

describe('settings service', () => {
  test('saves settings and never returns the key value', () => {
    const { service } = makeService();
    const result = service.save(validInput);
    assert.equal(result.status, 'saved');
    assert.ok(!JSON.stringify(result).includes('sk-or-test'));
    if (result.status === 'saved') {
      assert.equal(result.settings.openRouter.keyConfigured, true);
      assert.equal(result.settings.openRouter.model, 'vendor/model-name:free');
    }
  });

  test('a blank key keeps the saved key; a new key replaces it', () => {
    const { stores, service } = makeService();
    service.save(validInput);
    const firstId = stores.settings.get<string>(SettingKey.openRouterKeySecretId)!;

    assert.equal(service.save({ ...validInput, openRouterApiKey: '' }).status, 'saved');
    assert.equal(stores.settings.get<string>(SettingKey.openRouterKeySecretId), firstId);
    assert.equal(stores.secrets.read(firstId), 'sk-or-test');

    service.save({ ...validInput, openRouterApiKey: 'sk-or-new' });
    const secondId = stores.settings.get<string>(SettingKey.openRouterKeySecretId)!;
    assert.notEqual(secondId, firstId);
    assert.equal(stores.secrets.read(secondId), 'sk-or-new');
    assert.ok(!stores.secrets.has(firstId), 'old key is deleted');
  });

  test('requires a key on first save', () => {
    const { service } = makeService();
    const result = service.save({ ...validInput, openRouterApiKey: '' });
    assert.equal(result.status, 'invalid');
  });

  test('does not save anything when secure storage is unavailable', () => {
    const { stores, service } = makeService(false);
    const result = service.save(validInput);
    assert.equal(result.status, 'invalid');
    assert.equal(stores.settings.get(SettingKey.openRouterModel), null);
  });

  test('adds an IMAP account with its password stored only as a secret', () => {
    const { db, service } = makeService();
    const result = service.addAccount({
      address: 'Someone@Example.com',
      provider: 'imap',
      imap: { host: 'imap.example.com', port: 993, username: 'someone', password: 'pw-test' },
    });
    assert.equal(result.status, 'saved');
    if (result.status !== 'saved') return;
    const [account] = result.settings.accounts;
    assert.equal(account.address, 'someone@example.com');
    assert.equal(account.connectionState, 'not-connected');
    assert.deepEqual(account.imap, { host: 'imap.example.com', port: 993, username: 'someone' });
    assert.ok(!JSON.stringify(result).includes('pw-test'));
    const row = db.prepare('SELECT config_json FROM accounts').get() as { config_json: string };
    assert.ok(!row.config_json.includes('pw-test'));
  });

  test('rejects duplicate accounts and incomplete IMAP details', () => {
    const { service } = makeService();
    service.addAccount({ address: 'a@example.com', provider: 'gmail' });
    const duplicate = service.addAccount({ address: 'A@example.com', provider: 'gmail' });
    assert.equal(duplicate.status, 'invalid');

    const incomplete = service.addAccount({ address: 'b@example.com', provider: 'imap', imap: { port: 0 } });
    assert.equal(incomplete.status, 'invalid');
    if (incomplete.status === 'invalid') {
      assert.deepEqual(Object.keys(incomplete.fieldErrors).sort(), [
        'imapHost',
        'imapPassword',
        'imapPort',
        'imapUsername',
      ]);
    }
  });

  test('removing an account deletes its stored password', () => {
    const { db, service } = makeService();
    const added = service.addAccount({
      address: 'c@example.com',
      provider: 'imap',
      imap: { host: 'imap.example.com', port: 993, username: 'c', password: 'pw' },
    });
    assert.equal(added.status, 'saved');
    if (added.status !== 'saved') return;
    const id = added.settings.accounts[0].id;
    const removed = service.removeAccount(id);
    assert.equal(removed.status, 'saved');
    if (removed.status === 'saved') assert.equal(removed.settings.accounts.length, 0);
    const count = db.prepare('SELECT COUNT(*) AS n FROM secrets').get() as { n: number };
    assert.equal(count.n, 0);
  });
});
