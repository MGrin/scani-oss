/**
 * Encryption utility for sensitive data
 * Uses AES-256-GCM encryption with a key from environment variables
 */

import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // For AES, this is always 16 bytes
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

/**
 * Get encryption key from environment variable
 * The key should be a hex string (64 characters for 32 bytes)
 * Returns null if ENCRYPTION_KEY is not set
 */
function getEncryptionKey(): Buffer | null {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    return null;
  }

  // If the key is already in hex format (64 chars)
  if (key.length === KEY_LENGTH * 2) {
    return Buffer.from(key, 'hex');
  }

  // Otherwise, derive a key from the provided string
  return crypto.scryptSync(key, 'scani-salt', KEY_LENGTH);
}

/**
 * Encrypt a string or object
 * Returns a base64-encoded string containing IV, salt, tag, and encrypted data
 * If ENCRYPTION_KEY is not set, returns the plain text as a JSON string
 */
export function encrypt(data: string | Record<string, unknown>): string {
  try {
    const key = getEncryptionKey();

    // Convert data to string if it's an object
    const plaintext = typeof data === 'string' ? data : JSON.stringify(data);

    // If no encryption key is available, return plain text
    if (!key) {
      return plaintext;
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);

    // Create cipher
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    // Encrypt the data
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

    // Get the auth tag
    const tag = cipher.getAuthTag();

    // Combine everything into a single buffer: IV + salt + tag + encrypted data
    const combined = Buffer.concat([iv, salt, tag, encrypted]);

    // Return as base64 string
    return combined.toString('base64');
  } catch (error) {
    throw new Error(
      `Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Helper function to parse plain text data
 * Attempts to parse as JSON if it looks like JSON, otherwise returns as-is
 */
function parsePlainText<T>(data: string): T {
  if (data.startsWith('{') || data.startsWith('[')) {
    try {
      return JSON.parse(data) as T;
    } catch {
      // If parsing fails, return as string
      return data as T;
    }
  }
  return data as T;
}

/**
 * Decrypt a string that was encrypted with the encrypt function
 * Returns the original string or parsed object
 * If ENCRYPTION_KEY is not set, attempts to parse the data as plain text
 */
export function decrypt<T = string>(encryptedData: string): T {
  try {
    const key = getEncryptionKey();

    // If no encryption key is available, treat as plain text
    if (!key) {
      return parsePlainText<T>(encryptedData);
    }

    // Try to decode from base64 - if it fails, might be plain text
    let combined: Buffer;
    try {
      combined = Buffer.from(encryptedData, 'base64');
    } catch {
      // If base64 decoding fails, treat as plain text
      return parsePlainText<T>(encryptedData);
    }

    // Check if the data is large enough to be encrypted data
    // Minimum size: IV (16) + salt (64) + tag (16) + at least 1 byte of encrypted data = 97 bytes
    const minEncryptedSize = IV_LENGTH + SALT_LENGTH + TAG_LENGTH + 1;
    if (combined.length < minEncryptedSize) {
      // Too small to be encrypted, treat as plain text
      return parsePlainText<T>(encryptedData);
    }

    // Extract components (salt is stored but not needed for decryption with fixed key)
    const iv = combined.subarray(0, IV_LENGTH);
    const tag = combined.subarray(IV_LENGTH + SALT_LENGTH, IV_LENGTH + SALT_LENGTH + TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + SALT_LENGTH + TAG_LENGTH);

    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    // Decrypt the data
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    const decryptedString = decrypted.toString('utf8');

    // Try to parse as JSON if it looks like JSON
    return parsePlainText<T>(decryptedString);
  } catch (error) {
    throw new Error(
      `Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Encrypt credentials for storage
 * If ENCRYPTION_KEY is not set, stores data in plain text with encrypted: false
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
 * Decrypt credentials from storage
 * Handles both encrypted and plain text formats
 */
export function decryptCredentials(
  encryptedCredentials: Record<string, unknown>
): Record<string, unknown> {
  if (typeof encryptedCredentials !== 'object' || !encryptedCredentials.data) {
    throw new Error('Invalid encrypted credentials format');
  }

  // Check if data was actually encrypted
  const wasEncrypted = encryptedCredentials.encrypted === true;

  // If it wasn't encrypted (plain text), parse directly
  if (!wasEncrypted) {
    const data = encryptedCredentials.data;
    if (typeof data === 'string') {
      try {
        return JSON.parse(data) as Record<string, unknown>;
      } catch {
        // If it's not valid JSON, wrap it
        return { data };
      }
    }
    // If data is already an object, return it
    return data as Record<string, unknown>;
  }

  // Otherwise, decrypt normally
  return decrypt<Record<string, unknown>>(encryptedCredentials.data as string);
}

/**
 * Check if encryption key is available
 */
export function hasEncryptionKey(): boolean {
  return !!process.env.ENCRYPTION_KEY;
}
