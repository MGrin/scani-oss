import { describe, expect, test } from 'bun:test';
import { defaultInflowKey, extractXffTail, InMemoryInflowRateLimiter } from '../src/index';

function req(headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request('http://test/', { method, headers });
}

describe('InMemoryInflowRateLimiter', () => {
  test('admits requests under the limit', async () => {
    const limiter = new InMemoryInflowRateLimiter({
      windowMs: 60_000,
      max: 5,
      namespace: 'test',
      key: () => 'fixed-id',
    });
    for (let i = 0; i < 5; i++) {
      const out = await limiter.tryConsume(req());
      expect(out.ok).toBe(true);
    }
  });

  test('rejects the (max+1)-th request with retryAfterSec', async () => {
    const limiter = new InMemoryInflowRateLimiter({
      windowMs: 60_000,
      max: 2,
      namespace: 'test',
      key: () => 'id',
    });
    await limiter.tryConsume(req());
    await limiter.tryConsume(req());
    const out = await limiter.tryConsume(req());
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.retryAfterSec).toBeGreaterThan(0);
      expect(out.retryAfterSec).toBeLessThanOrEqual(60);
    }
  });

  test('partitions buckets by identity (different keys → independent budgets)', async () => {
    let nextId = 'a';
    const limiter = new InMemoryInflowRateLimiter({
      windowMs: 60_000,
      max: 1,
      namespace: 'test',
      key: () => nextId,
    });
    expect((await limiter.tryConsume(req())).ok).toBe(true);
    nextId = 'b';
    expect((await limiter.tryConsume(req())).ok).toBe(true);
  });

  test('respects custom token cost (consume N at once)', async () => {
    const limiter = new InMemoryInflowRateLimiter({
      windowMs: 60_000,
      max: 5,
      namespace: 'test',
      key: () => 'id',
    });
    expect((await limiter.tryConsume(req(), 3)).ok).toBe(true);
    expect((await limiter.tryConsume(req(), 2)).ok).toBe(true);
    expect((await limiter.tryConsume(req(), 1)).ok).toBe(false);
  });

  test('honours sub-second window precision (rounded up to 1 second)', async () => {
    const limiter = new InMemoryInflowRateLimiter({
      windowMs: 500,
      max: 1,
      namespace: 'test',
      key: () => 'id',
    });
    expect((await limiter.tryConsume(req())).ok).toBe(true);
    const out = await limiter.tryConsume(req());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.retryAfterSec).toBeGreaterThanOrEqual(1);
  });
});

describe('defaultInflowKey', () => {
  test('prefers cf-connecting-ip', () => {
    expect(defaultInflowKey(req({ 'cf-connecting-ip': '1.1.1.1' }))).toBe('1.1.1.1');
  });

  test('falls through to fly-client-ip', () => {
    expect(defaultInflowKey(req({ 'fly-client-ip': '2.2.2.2' }))).toBe('2.2.2.2');
  });

  test('falls through to x-real-ip', () => {
    expect(defaultInflowKey(req({ 'x-real-ip': '3.3.3.3' }))).toBe('3.3.3.3');
  });

  test('takes the rightmost X-Forwarded-For entry (trusted edge IP)', () => {
    expect(defaultInflowKey(req({ 'x-forwarded-for': '6.6.6.6, 5.5.5.5, 4.4.4.4' }))).toBe(
      '4.4.4.4'
    );
  });

  test('final UA+origin+method fallback when no proxy headers present', () => {
    const k = defaultInflowKey(req({ 'user-agent': 'curl/8' }, 'POST'));
    expect(k).toContain('curl/8');
    expect(k).toContain('POST');
  });
});

describe('extractXffTail', () => {
  test('returns null for null input', () => {
    expect(extractXffTail(null)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(extractXffTail('')).toBeNull();
  });

  test('returns the rightmost non-empty entry', () => {
    expect(extractXffTail('a, b, c')).toBe('c');
    expect(extractXffTail('a,, b ,, c')).toBe('c');
  });

  test('handles a single-entry list', () => {
    expect(extractXffTail('only')).toBe('only');
  });
});
