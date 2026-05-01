import { describe, expect, test } from 'bun:test';
import { credentialBucketKey } from '../src/index';

describe('credentialBucketKey', () => {
  test('returns a 12-char lowercase hex string', () => {
    const key = credentialBucketKey('AKIAxxxx-secret-payload');
    expect(key).toMatch(/^[0-9a-f]{12}$/);
  });

  test('is deterministic for the same input', () => {
    expect(credentialBucketKey('same-input')).toBe(credentialBucketKey('same-input'));
  });

  test('different inputs produce different keys', () => {
    expect(credentialBucketKey('a')).not.toBe(credentialBucketKey('b'));
  });

  test('trims whitespace before hashing', () => {
    expect(credentialBucketKey('  abc  ')).toBe(credentialBucketKey('abc'));
  });

  test('does not leak the raw value', () => {
    const raw = 'sk_live_VERYSECRETtoken_42';
    const key = credentialBucketKey(raw);
    expect(key).not.toContain('VERYSECRET');
    expect(key).not.toContain('sk_live');
  });
});
