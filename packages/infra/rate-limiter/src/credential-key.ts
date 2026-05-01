import { createHash } from 'node:crypto';

/**
 * Derive a stable, short, non-reversible key from a raw credential so it
 * can safely be used as a rate-limiter bucket partition. Raw API keys
 * must never become a Redis key (the infra logs keys + the value is
 * highly sensitive). 12 hex chars = 48 bits ≈ zero collision risk at
 * Scani's scale.
 */
export function credentialBucketKey(raw: string): string {
  return createHash('sha256').update(raw.trim()).digest('hex').slice(0, 12);
}
