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
 */
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
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
 */
export function encrypt(data: string | Record<string, unknown>): string {
  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);

    // Convert data to string if it's an object
    const plaintext = typeof data === 'string' ? data : JSON.stringify(data);

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
 * Decrypt a string that was encrypted with the encrypt function
 * Returns the original string or parsed object
 */
export function decrypt<T = string>(encryptedData: string): T {
  try {
    const key = getEncryptionKey();

    // Decode from base64
    const combined = Buffer.from(encryptedData, 'base64');

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
    if (decryptedString.startsWith('{') || decryptedString.startsWith('[')) {
      try {
        return JSON.parse(decryptedString) as T;
      } catch {
        // If parsing fails, return as string
        return decryptedString as T;
      }
    }

    return decryptedString as T;
  } catch (error) {
    throw new Error(
      `Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Encrypt credentials for storage
 */
export function encryptCredentials(credentials: Record<string, unknown>): Record<string, unknown> {
  const encryptedData = encrypt(credentials);
  return {
    encrypted: true,
    data: encryptedData,
  };
}

/**
 * Decrypt credentials from storage
 */
export function decryptCredentials(
  encryptedCredentials: Record<string, unknown>
): Record<string, unknown> {
  if (typeof encryptedCredentials !== 'object' || !encryptedCredentials.data) {
    throw new Error('Invalid encrypted credentials format');
  }

  return decrypt<Record<string, unknown>>(encryptedCredentials.data as string);
}

/**
 * Check if encryption key is available
 */
export function hasEncryptionKey(): boolean {
  return !!process.env.ENCRYPTION_KEY;
}
