import { describe, expect, test } from 'bun:test';
import { InMemoryInflowRateLimiter } from '../../src/inflow/in-memory';

describe('InflowRateLimiter.tryConsumeKey', () => {
  test('allows up to max within the window, then blocks', async () => {
    const limiter = new InMemoryInflowRateLimiter({
      windowMs: 60_000,
      max: 3,
      namespace: 'rl:test',
    });
    expect(await limiter.tryConsumeKey('user:a')).toEqual({ ok: true });
    expect(await limiter.tryConsumeKey('user:a')).toEqual({ ok: true });
    expect(await limiter.tryConsumeKey('user:a')).toEqual({ ok: true });
    const fourth = await limiter.tryConsumeKey('user:a');
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      expect(fourth.retryAfterSec).toBeGreaterThan(0);
      expect(fourth.retryAfterSec).toBeLessThanOrEqual(60);
    }
  });

  test('separate identities have separate buckets', async () => {
    const limiter = new InMemoryInflowRateLimiter({
      windowMs: 60_000,
      max: 1,
      namespace: 'rl:test',
    });
    expect(await limiter.tryConsumeKey('user:a')).toEqual({ ok: true });
    expect(await limiter.tryConsumeKey('user:b')).toEqual({ ok: true });
    expect((await limiter.tryConsumeKey('user:a')).ok).toBe(false);
    expect((await limiter.tryConsumeKey('user:b')).ok).toBe(false);
  });

  test('multi-token consume', async () => {
    const limiter = new InMemoryInflowRateLimiter({
      windowMs: 60_000,
      max: 5,
      namespace: 'rl:test',
    });
    expect(await limiter.tryConsumeKey('user:a', 3)).toEqual({ ok: true });
    expect(await limiter.tryConsumeKey('user:a', 3)).toMatchObject({ ok: false });
  });
});
