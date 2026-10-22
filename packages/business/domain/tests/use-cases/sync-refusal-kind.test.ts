import { describe, expect, test } from 'bun:test';
import { ProviderError } from '@scani/providers/core/errors';
import { needsReconnect } from '../../src/use-cases/SyncExchangeBalancesUseCase';
import { SUSPECT_CREDENTIAL, syncRefusalKind } from '../../src/use-cases/sync-refusal-kind';

// SC-1733: one Fio 500 may be an outage. Since SC-1728 an `auth-failed` key is
// not used again until replaced, so a suspect answer is confirmed by a second
// one at least an hour after the first before it pauses anything.
const NOW = new Date('2026-10-12T10:00:00Z');
const suspect = () =>
  new ProviderError('Fio answered 500', 'retryable', 'fio', { suspectCredential: true });
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe('the kind a sync records for a refusal', () => {
  test('CONTROL: a single suspect answer is recorded as a suspect and pauses nothing', () => {
    const kind = syncRefusalKind(suspect(), { syncRefusalKind: null, syncRefusalSince: null }, NOW);
    expect(kind).toBe(SUSPECT_CREDENTIAL);
    expect(needsReconnect({ syncRefusalKind: kind })).toBe(false);
  });

  test('a second suspect answer under an hour after the first is still a suspect', () => {
    const kind = syncRefusalKind(
      suspect(),
      { syncRefusalKind: SUSPECT_CREDENTIAL, syncRefusalSince: minutesAgo(59) },
      NOW
    );
    expect(kind).toBe(SUSPECT_CREDENTIAL);
  });

  test('a suspect answer an hour after the first suspect one confirms it: auth-failed', () => {
    const kind = syncRefusalKind(
      suspect(),
      { syncRefusalKind: SUSPECT_CREDENTIAL, syncRefusalSince: minutesAgo(60) },
      NOW
    );
    expect(kind).toBe('auth-failed');
    expect(needsReconnect({ syncRefusalKind: kind })).toBe(true);
  });

  test('a suspect answer after a different refusal starts its own count', () => {
    const kind = syncRefusalKind(
      suspect(),
      { syncRefusalKind: 'rate-limited', syncRefusalSince: minutesAgo(600) },
      NOW
    );
    expect(kind).toBe(SUSPECT_CREDENTIAL);
  });

  test('any other provider error keeps the kind the provider gave it', () => {
    const none = { syncRefusalKind: null, syncRefusalSince: null };
    expect(syncRefusalKind(new ProviderError('401', 'auth-failed', 'bybit'), none, NOW)).toBe(
      'auth-failed'
    );
    expect(syncRefusalKind(new ProviderError('503', 'retryable', 'fio'), none, NOW)).toBe(
      'retryable'
    );
    expect(syncRefusalKind(new Error('boom'), none, NOW)).toBeNull();
  });
});
