import crypto from 'node:crypto';
import { isProduction } from '@scani/config';
import { loadSecurityConfig } from './config';

// AES-256-GCM credential encryption with per-record salts.
//
// Envelope layout (base64-encoded on the wire):
//   IV(16) || salt(64) || tag(16) || ciphertext
//
// Two key-derivation paths exist:
//
//  1. ENCRYPTION_KEY is a 64-char hex string → bytes are used directly as
//     the 32-byte AES key. No KDF. Production deployments stage this
//     shape; it's the canonical production setup. The salt slot in the
//     envelope is still random but unused (kept for format compatibility).
//
//  2. ENCRYPTION_KEY is any other ≥32-char string → scrypt(key, salt)
//     derives the AES key. New encrypts use the random salt from the
//     envelope; decrypts try that first and fall back to the historic
//     constant salt (`'scani-salt'`) so records written before the
//     2026-05 fix still round-trip.
//
// Production safety lives in two places: `loadSecurityConfig` refuses
// to parse the env without ENCRYPTION_KEY in production, AND `encrypt` /
// `decrypt` throw if they reach the plaintext-passthrough branch while
// `isProduction === true`. The dev/test paths still tolerate plaintext
// for docker-compose stacks and unit tests.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const LEGACY_KDF_SALT = 'scani-salt';

// scrypt is intentionally slow (~50-100ms per call) — caching the
// derived key across calls is essential when the worker decrypts dozens
// of credentials per import job. Keyed on `(rawKey, salt)` so per-record
// salts each occupy their own slot. Bounded LRU so misbehaving callers
// can't grow it unbounded.
//
// Only the non-hex KDF path uses this cache; production stages a 64-char
// hex ENCRYPTION_KEY (see `isHexKey`) which skips scrypt entirely. The
// cap is sized so a dev/test import decrypting many per-record-salted
// rows in one pass doesn't thrash and re-derive on every credential.
const KDF_CACHE = new Map<string, Buffer>();
const KDF_CACHE_MAX = 256;

function deriveScryptKey(rawKey: string, salt: Buffer | string): Buffer {
  const saltKey = typeof salt === 'string' ? salt : salt.toString('hex');
  const cacheKey = `${rawKey.length}:${rawKey}:${saltKey}`;
  const cached = KDF_CACHE.get(cacheKey);
  if (cached) {
    // Touch LRU recency.
    KDF_CACHE.delete(cacheKey);
    KDF_CACHE.set(cacheKey, cached);
    return cached;
  }
  const derived = crypto.scryptSync(rawKey, salt, KEY_LENGTH);
  if (KDF_CACHE.size >= KDF_CACHE_MAX) {
    const oldest = KDF_CACHE.keys().next().value;
    if (oldest) KDF_CACHE.delete(oldest);
  }
  KDF_CACHE.set(cacheKey, derived);
  return derived;
}

function getRawKey(): string | null {
  const { ENCRYPTION_KEY: key } = loadSecurityConfig();
  return key ?? null;
}

function isHexKey(rawKey: string): boolean {
  return rawKey.length === KEY_LENGTH * 2 && /^[0-9a-fA-F]+$/.test(rawKey);
}

function deriveAesKey(rawKey: string, saltForKdf: Buffer | string): Buffer {
  if (isHexKey(rawKey)) return Buffer.from(rawKey, 'hex');
  return deriveScryptKey(rawKey, saltForKdf);
}

/**
 * Encrypts a string or object. Returns a base64-encoded envelope
 * containing IV + salt + tag + ciphertext. When ENCRYPTION_KEY is unset
 * (dev/test only) returns the plaintext as a string. Production refuses
 * the plaintext branch even if `loadSecurityConfig` somehow returned an
 * empty key.
 */
export function encrypt(data: string | Record<string, unknown>): string {
  try {
    const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
    const rawKey = getRawKey();
    if (!rawKey) {
      if (isProduction) {
        throw new Error(
          'ENCRYPTION_KEY is required in production. Refusing to store sensitive data as plaintext.'
        );
      }
      return plaintext;
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = deriveAesKey(rawKey, salt);
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
 * original string or parsed object.
 *
 * Plaintext fallback is permitted ONLY outside production — under
 * `NODE_ENV=production` an undecryptable / malformed payload throws
 * loudly instead of being misread as plaintext, so a corrupted row
 * never silently flows downstream as if it were a valid credential.
 */
export function decrypt<T = string>(encryptedData: string): T {
  const rawKey = getRawKey();
  if (!rawKey) {
    if (isProduction) {
      throw new Error('ENCRYPTION_KEY is required in production. Refusing to decrypt.');
    }
    return parsePlainText<T>(encryptedData);
  }

  let combined: Buffer;
  try {
    combined = Buffer.from(encryptedData, 'base64');
  } catch (error) {
    throw new Error(
      `Decryption failed: payload is not valid base64 (${error instanceof Error ? error.message : 'unknown'})`
    );
  }

  // Minimum envelope: IV(16) + salt(64) + tag(16) + 1 byte ciphertext.
  const minEncryptedSize = IV_LENGTH + SALT_LENGTH + TAG_LENGTH + 1;
  if (combined.length < minEncryptedSize) {
    if (isProduction) {
      throw new Error(
        `Decryption failed: payload (${combined.length} bytes) smaller than envelope minimum (${minEncryptedSize})`
      );
    }
    // Dev/test: tolerate plaintext round-trip so seed fixtures + tests
    // that bypass encryption still work.
    return parsePlainText<T>(encryptedData);
  }

  const iv = combined.subarray(0, IV_LENGTH);
  const salt = combined.subarray(IV_LENGTH, IV_LENGTH + SALT_LENGTH);
  const tag = combined.subarray(IV_LENGTH + SALT_LENGTH, IV_LENGTH + SALT_LENGTH + TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH + SALT_LENGTH + TAG_LENGTH);

  // For hex (32-byte) keys the salt is irrelevant — the AES key is
  // fixed. For scrypt-derived keys, try the per-record salt first (post
  // 2026-05 format) and fall back to the legacy constant salt for
  // records written before the fix landed.
  const candidateKeys: Buffer[] = isHexKey(rawKey)
    ? [Buffer.from(rawKey, 'hex')]
    : [deriveScryptKey(rawKey, salt), deriveScryptKey(rawKey, LEGACY_KDF_SALT)];

  let lastError: Error | null = null;
  for (const key of candidateKeys) {
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return parsePlainText<T>(decrypted.toString('utf8'));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new Error(`Decryption failed: ${lastError?.message ?? 'authentication tag mismatch'}`);
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
    if (isProduction) {
      // A row flagged as plaintext in production indicates either a
      // pre-encryption migration not applied, or a misconfigured
      // ENCRYPTION_KEY at the time of write. Either way it's an
      // operator-level bug, not a decrypt-and-shrug situation —
      // surface it instead of silently using the plaintext.
      throw new Error(
        'Found plaintext credential row while running in production. Refusing to use.'
      );
    }
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
