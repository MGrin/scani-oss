import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { decrypt, encrypt, hasEncryptionKey } from './encryption';

describe('encryption', () => {
  const originalKey = process.env.ENCRYPTION_KEY;

  describe('with encryption key set', () => {
    beforeAll(() => {
      // Set a valid 64-char hex key (32 bytes)
      process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    });

    afterAll(() => {
      process.env.ENCRYPTION_KEY = originalKey;
    });

    it('should encrypt and decrypt a string', () => {
      const plaintext = 'my-secret-api-key';
      const encrypted = encrypt(plaintext);
      expect(encrypted).not.toBe(plaintext);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt an object', () => {
      const obj = { apiKey: 'key123', apiSecret: 'secret456' };
      const encrypted = encrypt(obj);
      expect(encrypted).not.toBe(JSON.stringify(obj));
      const decrypted = decrypt<Record<string, string>>(encrypted);
      expect(decrypted).toEqual(obj);
    });

    it('should produce different ciphertext for same input (random IV)', () => {
      const plaintext = 'same-input';
      const enc1 = encrypt(plaintext);
      const enc2 = encrypt(plaintext);
      expect(enc1).not.toBe(enc2);
    });

    it('should report encryption key is available', () => {
      expect(hasEncryptionKey()).toBe(true);
    });
  });

  describe('without encryption key', () => {
    beforeAll(() => {
      delete process.env.ENCRYPTION_KEY;
    });

    afterAll(() => {
      process.env.ENCRYPTION_KEY = originalKey;
    });

    it('should return plain text when no key is set', () => {
      const plaintext = 'my-secret';
      const result = encrypt(plaintext);
      expect(result).toBe(plaintext);
    });

    it('should return plain JSON when encrypting object without key', () => {
      const obj = { apiKey: 'key123' };
      const result = encrypt(obj);
      expect(result).toBe(JSON.stringify(obj));
    });

    it('should decrypt plain text (pass-through)', () => {
      const plaintext = 'not-encrypted';
      const result = decrypt(plaintext);
      expect(result).toBe(plaintext);
    });
  });
});
