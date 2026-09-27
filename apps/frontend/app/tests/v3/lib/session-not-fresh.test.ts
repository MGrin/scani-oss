import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { TRPCClientError } from '@trpc/client';
import { isSessionNotFresh } from '../../../src/v3/lib/session-not-fresh';

// SC-1351: the api refuses account deletion from a session older than five
// minutes with FORBIDDEN / SESSION_NOT_FRESH, and Settings answers that one
// refusal with a code sign-in instead of an error toast.
describe('isSessionNotFresh', () => {
  test('recognises the api refusal', () => {
    expect(isSessionNotFresh(new TRPCClientError('SESSION_NOT_FRESH'))).toBe(true);
  });

  test('any other failure is not it (control)', () => {
    expect(isSessionNotFresh(new TRPCClientError('Authentication required'))).toBe(false);
    expect(isSessionNotFresh(new Error('network'))).toBe(false);
    expect(isSessionNotFresh(null)).toBe(false);
  });
});
