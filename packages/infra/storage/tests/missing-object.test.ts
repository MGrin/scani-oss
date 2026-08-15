import { describe, expect, test } from 'bun:test';
import { isMissingObjectError } from '../src/missing-object';

describe('isMissingObjectError', () => {
  test('matches the message R2 actually returns through tRPC', () => {
    // The literal text of Sentry SCANI-WORKER-P. The predicate this
    // replaced (/NoSuchKey|404|not found/i) matched none of these words.
    expect(isMissingObjectError(new Error('The specified key does not exist.'))).toBe(true);
  });

  test('matches the raw S3 error name and an HTTP 404', () => {
    expect(isMissingObjectError(new Error('NoSuchKey: no such key'))).toBe(true);
    expect(isMissingObjectError(new Error('S3 request failed: 404'))).toBe(true);
    expect(isMissingObjectError(new Error('object not found'))).toBe(true);
  });

  test('accepts a non-Error thrown value', () => {
    expect(isMissingObjectError('NoSuchKey')).toBe(true);
    expect(isMissingObjectError(null)).toBe(false);
  });

  test('leaves real storage failures retryable', () => {
    // The counterweight that keeps this from swallowing an R2 incident.
    for (const message of [
      'R2 is returning 503 Service Unavailable',
      'SignatureDoesNotMatch',
      'AccessDenied',
      'socket hang up',
      'The operation was aborted.',
      'InternalError: 500',
    ]) {
      expect(isMissingObjectError(new Error(message))).toBe(false);
    }
  });

  test('does not match a 404 embedded in a longer number', () => {
    // `\b404\b` rather than a substring test: an object whose key or size
    // happens to contain 404 is not a missing object.
    expect(isMissingObjectError(new Error('upload failed after 14042 bytes'))).toBe(false);
  });
});
