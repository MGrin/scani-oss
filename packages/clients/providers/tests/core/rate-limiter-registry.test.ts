import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { RateLimiterRegistry } from '../../src/core/rate-limiter-registry';

function fakeLimiter(): OutflowRateLimiter {
  return {
    execute: async (_fn, _key) => undefined,
  } as unknown as OutflowRateLimiter;
}

describe('RateLimiterRegistry', () => {
  test('register + get', () => {
    const reg = new RateLimiterRegistry();
    const limiter = fakeLimiter();
    const returned = reg.register({
      namespace: 'foo',
      limiter,
      registeredFrom: 'tests',
      description: 'test limiter',
    });
    expect(returned).toBe(limiter);
    expect(reg.get('foo')).toBe(limiter);
  });

  test('get returns null for unknown namespace', () => {
    expect(new RateLimiterRegistry().get('missing')).toBeNull();
  });

  test('require throws for unknown namespace', () => {
    expect(() => new RateLimiterRegistry().require('missing')).toThrow(/not registered/);
  });

  test('register throws on duplicate, naming both registration sites', () => {
    const reg = new RateLimiterRegistry();
    reg.register({ namespace: 'kraken', limiter: fakeLimiter(), registeredFrom: 'first/site' });
    expect(() =>
      reg.register({ namespace: 'kraken', limiter: fakeLimiter(), registeredFrom: 'second/site' })
    ).toThrow(/first\/site.*second\/site/);
  });

  test('list returns metadata for every registered namespace', () => {
    const reg = new RateLimiterRegistry();
    reg.register({ namespace: 'a', limiter: fakeLimiter(), registeredFrom: 'p1' });
    reg.register({
      namespace: 'b',
      limiter: fakeLimiter(),
      registeredFrom: 'p2',
      description: 'b-desc',
    });
    const list = reg.list();
    expect(list).toHaveLength(2);
    expect(list.find((l) => l.namespace === 'b')?.description).toBe('b-desc');
  });
});
