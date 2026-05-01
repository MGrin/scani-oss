import crypto from 'node:crypto';
import { loadSecurityConfig } from './config';

// AES-256-GCM credential encryption with scrypt-derived keys.
//
// Production safety lives in `loadSecurityConfig` — when NODE_ENV=production
// the schema fails to parse without ENCRYPTION_KEY, so we never reach the
// plaintext-passthrough branch in prod. Outside production the passthrough
// is deliberate so dev / test can run without ceremony — the docker-compose
// stack and IntegrationCredentialsService.test.ts rely on it.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function getEncryptionKey(): Buffer | null {
  const { ENCRYPTION_KEY: key } = loadSecurityConfig();
  if (!key) return null;
  // Accept a hex-encoded 32-byte key directly, or derive one from any
  // string via scrypt.
  if (key.length === KEY_LENGTH * 2) {
    return Buffer.from(key, 'hex');
  }
  return crypto.scryptSync(key, 'scani-salt', KEY_LENGTH);
}

/**
 * Encrypts a string or object. Returns a base64-encoded string
 * containing IV + salt + tag + ciphertext. When ENCRYPTION_KEY is
 * unset (dev/test only) returns the plaintext as a string —
 * loadSecurityConfig blocks this branch in prod.
 */
export function encrypt(data: string | Record<string, unknown>): string {
  try {
    const key = getEncryptionKey();
    const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
    if (!key) return plaintext;

    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const combined = Buffer.concat([iv, salt, tag, encrypted]);
    return combined.toString('base64');
  } catch (error) {
    throw new Error(
      `Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

function parsePlainText<T>(data: string): T {
  if (data.startsWith('{') || data.startsWith('[')) {
    try {
      return JSON.parse(data) as T;
    } catch {
      return data as T;
    }
  }
  return data as T;
}

/**
 * Decrypts a string previously produced by `encrypt`. Returns the
 * original string or parsed object. Tolerates plaintext input (dev mode
 * round-trip).
 */
export function decrypt<T = string>(encryptedData: string): T {
  try {
    const key = getEncryptionKey();
    if (!key) return parsePlainText<T>(encryptedData);

    let combined: Buffer;
    try {
      combined = Buffer.from(encryptedData, 'base64');
    } catch {
      return parsePlainText<T>(encryptedData);
    }

    // Minimum size: IV(16) + salt(64) + tag(16) + 1 byte ciphertext = 97.
    const minEncryptedSize = IV_LENGTH + SALT_LENGTH + TAG_LENGTH + 1;
    if (combined.length < minEncryptedSize) {
      return parsePlainText<T>(encryptedData);
    }

    const iv = combined.subarray(0, IV_LENGTH);
    const tag = combined.subarray(IV_LENGTH + SALT_LENGTH, IV_LENGTH + SALT_LENGTH + TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + SALT_LENGTH + TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return parsePlainText<T>(decrypted.toString('utf8'));
  } catch (error) {
    throw new Error(
      `Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Wraps `encrypt` with a metadata envelope `{ encrypted, data }` so
 * `decryptCredentials` can tell encrypted-at-rest rows apart from
 * dev-mode plaintext rows in mixed databases.
 */
export function encryptCredentials(credentials: Record<string, unknown>): Record<string, unknown> {
  const hasKey = hasEncryptionKey();
  const encryptedData = encrypt(credentials);
  return {
    encrypted: hasKey,
    data: encryptedData,
  };
}

/**
 * Inverse of `encryptCredentials`. Reads the envelope flag to decide
 * whether the payload is base64 ciphertext or plaintext JSON.
 */
export function decryptCredentials(
  encryptedCredentials: Record<string, unknown>
): Record<string, unknown> {
  if (typeof encryptedCredentials !== 'object' || !encryptedCredentials.data) {
    throw new Error('Invalid encrypted credentials format');
  }
  const wasEncrypted = encryptedCredentials.encrypted === true;
  if (!wasEncrypted) {
    const data = encryptedCredentials.data;
    if (typeof data === 'string') {
      try {
        return JSON.parse(data) as Record<string, unknown>;
      } catch {
        return { data };
      }
    }
    return data as Record<string, unknown>;
  }
  return decrypt<Record<string, unknown>>(encryptedCredentials.data as string);
}

export function hasEncryptionKey(): boolean {
  return !!loadSecurityConfig().ENCRYPTION_KEY;
}
