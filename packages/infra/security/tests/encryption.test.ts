import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { resetSecurityConfig } from '../src/config';
import { decrypt, encrypt, hasEncryptionKey } from '../src/encryption';

describe('encryption', () => {
  const originalKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    resetSecurityConfig();
  });
  afterEach(() => {
    resetSecurityConfig();
  });

  describe('with encryption key set', () => {
    beforeAll(() => {
      // Set a valid 64-char hex key (32 bytes)
      process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    });

    afterAll(() => {
      process.env.ENCRYPTION_KEY = originalKey;
    });

    it('encrypts and decrypts a string', () => {
      const plaintext = 'my-secret-api-key';
      const encrypted = encrypt(plaintext);
      expect(encrypted).not.toBe(plaintext);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('encrypts and decrypts an object', () => {
      const obj = { apiKey: 'key123', apiSecret: 'secret456' };
      const encrypted = encrypt(obj);
      expect(encrypted).not.toBe(JSON.stringify(obj));
      const decrypted = decrypt<Record<string, string>>(encrypted);
      expect(decrypted).toEqual(obj);
    });

    it('produces different ciphertext for the same input (random IV)', () => {
      const plaintext = 'same-input';
      const enc1 = encrypt(plaintext);
      const enc2 = encrypt(plaintext);
      expect(enc1).not.toBe(enc2);
    });

    it('reports the encryption key is available', () => {
      expect(hasEncryptionKey()).toBe(true);
    });
  });

  describe('without encryption key (dev/test fallback)', () => {
    beforeAll(() => {
      delete process.env.ENCRYPTION_KEY;
    });

    afterAll(() => {
      process.env.ENCRYPTION_KEY = originalKey;
    });

    it('returns plain text when no key is set', () => {
      const plaintext = 'my-secret';
      expect(encrypt(plaintext)).toBe(plaintext);
    });

    it('returns plain JSON when encrypting an object without a key', () => {
      const obj = { apiKey: 'key123' };
      expect(encrypt(obj)).toBe(JSON.stringify(obj));
    });

    it('decrypts plain text as pass-through', () => {
      const plaintext = 'not-encrypted';
      expect(decrypt(plaintext)).toBe(plaintext);
    });

    it('reports the encryption key is unavailable', () => {
      expect(hasEncryptionKey()).toBe(false);
    });
  });
});
