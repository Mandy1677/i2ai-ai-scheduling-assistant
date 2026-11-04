import type { DatabaseSync } from 'node:sqlite';

/** Non-secret settings, stored as JSON values. Secret values never go here. */
export class SettingsStore {
  constructor(private readonly db: DatabaseSync) {}

  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value));
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}

export const SettingKey = {
  historyRange: 'sync.historyRange',
  openRouterModel: 'openRouter.model',
  openRouterKeySecretId: 'openRouter.keySecretId',
  calendar: 'calendar.connection',
} as const;
