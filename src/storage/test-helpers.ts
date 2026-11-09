import type { Encryptor } from './secret-store';

/** Reversible stand-in for safeStorage in tests; output never equals the input. */
export function fakeEncryptor(available = true): Encryptor {
  return {
    isAvailable: () => available,
    encrypt: (text) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
    decrypt: (buf) => Buffer.from(buf.toString().slice(4), 'base64').toString(),
  };
}
