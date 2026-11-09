import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { nowIso } from './database';

/** OS-backed encryption; the App passes Electron's safeStorage. */
export interface Encryptor {
  isAvailable(): boolean;
  encrypt(plainText: string): Buffer;
  decrypt(cipherText: Buffer): string;
}

export class SecureStorageUnavailableError extends Error {
  constructor() {
    super('OS-backed secure storage is unavailable');
    this.name = 'SecureStorageUnavailableError';
  }
}

/**
 * Stores secrets only as OS-encrypted ciphertext, referenced by ID.
 * Fails instead of ever writing plaintext.
 */
export class SecretStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly encryptor: Encryptor,
  ) {}

  isAvailable(): boolean {
    return this.encryptor.isAvailable();
  }

  save(value: string): string {
    if (!this.encryptor.isAvailable()) throw new SecureStorageUnavailableError();
    const id = randomUUID();
    const cipherText = this.encryptor.encrypt(value);
    this.db
      .prepare('INSERT INTO secrets (id, ciphertext, created_at) VALUES (?, ?, ?)')
      .run(id, cipherText, nowIso());
    return id;
  }

  read(id: string): string | null {
    if (!this.encryptor.isAvailable()) throw new SecureStorageUnavailableError();
    const row = this.db.prepare('SELECT ciphertext FROM secrets WHERE id = ?').get(id) as
      | { ciphertext: Uint8Array }
      | undefined;
    return row ? this.encryptor.decrypt(Buffer.from(row.ciphertext)) : null;
  }

  has(id: string | null): boolean {
    if (!id) return false;
    return this.db.prepare('SELECT 1 FROM secrets WHERE id = ?').get(id) !== undefined;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM secrets WHERE id = ?').run(id);
  }
}
