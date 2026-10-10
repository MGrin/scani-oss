import { describe, expect, test } from 'bun:test';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { Container } from 'typedi';
import { ApiCallCounter, apiCallsKey } from '../../src/core/api-call-counter';
import { RateLimiterRegistry } from '../../src/core/rate-limiter-registry';

restoreContainerAfterAll();

function passThroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

describe('upstream calls per UTC day and limiter namespace (SC-1665)', () => {
  test('the key names the UTC day and the namespace', () => {
    expect(apiCallsKey(new Date('2026-10-09T23:59:59Z'), 'airwallex-private')).toBe(
      'api:calls:2026-10-09:airwallex-private'
    );
  });

  test('every call through a registered limiter counts once, under its own namespace', async () => {
    const counter = new ApiCallCounter();
    Container.set(ApiCallCounter, counter);
    const reg = new RateLimiterRegistry();
    const airwallex = reg.register({
      namespace: 'airwallex-private',
      limiter: passThroughLimiter(),
      registeredFrom: 'tests',
    });
    reg.register({
      namespace: 'kraken-private',
      limiter: passThroughLimiter(),
      registeredFrom: 'tests',
    });

    expect(await airwallex.execute(async () => 'a')).toBe('a');
    await airwallex.execute(async () => 'b', 'credential-bucket');
    await reg.require('kraken-private').execute(async () => 'c');

    const today = new Date();
    expect(await counter.read(today, 'airwallex-private')).toBe(2);
    expect(await counter.read(today, 'kraken-private')).toBe(1);
  });

  test('a call the limiter never let out is not counted', async () => {
    const counter = new ApiCallCounter();
    const refusing = {
      execute: async () => {
        throw new Error('aborted while waiting for a slot');
      },
    } as unknown as OutflowRateLimiter;
    Container.set(ApiCallCounter, counter);
    const limiter = new RateLimiterRegistry().register({
      namespace: 'gate-private',
      limiter: refusing,
      registeredFrom: 'tests',
    });

    await expect(limiter.execute(async () => 'never')).rejects.toThrow(/aborted/);
    expect(await counter.read(new Date(), 'gate-private')).toBe(0);
  });
});
