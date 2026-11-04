import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AccountProvider, AccountSummary, ConnectionState, ImapSettings } from '../shared/contracts';
import { nowIso } from './database';

export interface NewAccount {
  address: string;
  provider: AccountProvider;
  imap: Omit<ImapSettings, 'password'> | null;
  credentialSecretId: string | null;
}

interface AccountRow {
  id: string;
  address: string;
  provider: AccountProvider;
  config_json: string;
  credential_secret_id: string | null;
  connection_state: ConnectionState;
}

export class AccountStore {
  constructor(private readonly db: DatabaseSync) {}

  list(): AccountSummary[] {
    const rows = this.db
      .prepare(
        'SELECT id, address, provider, config_json, credential_secret_id, connection_state FROM accounts ORDER BY created_at, address',
      )
      .all() as unknown as AccountRow[];
    return rows.map((row) => {
      const config = JSON.parse(row.config_json) as { imap?: Omit<ImapSettings, 'password'> };
      return {
        id: row.id,
        address: row.address,
        provider: row.provider,
        connectionState: row.connection_state,
        imap: config.imap ?? null,
      };
    });
  }

  get(id: string): (AccountSummary & { folderScope: string; credentialSecretId: string | null }) | null {
    const row = this.db
      .prepare(
        'SELECT id, address, provider, config_json, folder_scope, credential_secret_id, connection_state FROM accounts WHERE id = ?',
      )
      .get(id) as (AccountRow & { folder_scope: string }) | undefined;
    if (!row) return null;
    const config = JSON.parse(row.config_json) as { imap?: Omit<ImapSettings, 'password'> };
    return {
      id: row.id,
      address: row.address,
      provider: row.provider,
      connectionState: row.connection_state,
      imap: config.imap ?? null,
      folderScope: row.folder_scope,
      credentialSecretId: row.credential_secret_id,
    };
  }

  setConnection(id: string, state: ConnectionState, credentialSecretId: string | null): void {
    this.db
      .prepare('UPDATE accounts SET connection_state = ?, credential_secret_id = ? WHERE id = ?')
      .run(state, credentialSecretId, id);
  }

  exists(address: string): boolean {
    return this.db.prepare('SELECT 1 FROM accounts WHERE address = ?').get(address) !== undefined;
  }

  add(account: NewAccount): string {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO accounts (id, address, provider, config_json, credential_secret_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        account.address,
        account.provider,
        JSON.stringify(account.imap ? { imap: account.imap } : {}),
        account.credentialSecretId,
        nowIso(),
      );
    return id;
  }

  /** Removes the account and its queued work; returns its credential secret ID. */
  remove(id: string): { removed: boolean; credentialSecretId: string | null } {
    const row = this.db.prepare('SELECT credential_secret_id FROM accounts WHERE id = ?').get(id) as
      | { credential_secret_id: string | null }
      | undefined;
    if (!row) return { removed: false, credentialSecretId: null };
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    return { removed: true, credentialSecretId: row.credential_secret_id };
  }

  countConnected(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM accounts WHERE connection_state = 'connected'")
      .get() as { n: number };
    return row.n;
  }
}
