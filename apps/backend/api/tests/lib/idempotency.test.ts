import { afterEach, describe, expect, mock, test } from 'bun:test';
import { _resetIdempotencyCache, withIdempotency } from '../../src/lib/idempotency';

afterEach(() => {
  _resetIdempotencyCache();
});

describe('withIdempotency', () => {
  test('executes when no idempotency key is supplied', async () => {
    const fn = mock(async () => 'result');
    const v = await withIdempotency('user-1', undefined, fn);
    expect(v).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('returns the cached value on second call within TTL', async () => {
    const fn = mock(async () => ({ id: 'a-1' }));
    const first = await withIdempotency('user-1', 'key-x', fn);
    const second = await withIdempotency('user-1', 'key-x', fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  test('different idempotency keys execute independently', async () => {
    const fn = mock(async () => Math.random());
    await withIdempotency('user-1', 'key-a', fn);
    await withIdempotency('user-1', 'key-b', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('different users with the same key execute independently', async () => {
    const fn = mock(async () => 1);
    await withIdempotency('user-a', 'key-x', fn);
    await withIdempotency('user-b', 'key-x', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('expired entry causes re-execution', async () => {
    const fn = mock(async () => 'v');
    // Set a very short TTL so we don't depend on time travel.
    await withIdempotency('user-1', 'key-x', fn, 1);
    // Wait past the 1ms TTL.
    await new Promise((r) => setTimeout(r, 5));
    await withIdempotency('user-1', 'key-x', fn, 1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('concurrent calls with the same key share one execution', async () => {
    let resolve!: (v: string) => void;
    const work = new Promise<string>((r) => {
      resolve = r;
    });
    const fn = mock(() => work);

    const p1 = withIdempotency('user-1', 'key-x', fn);
    const p2 = withIdempotency('user-1', 'key-x', fn);
    // Same in-flight promise, so the underlying work runs once.
    expect(fn).toHaveBeenCalledTimes(1);

    resolve('shared');
    await expect(p1).resolves.toBe('shared');
    await expect(p2).resolves.toBe('shared');
  });

  test('errors do NOT poison the cache (next call retries)', async () => {
    const fn = mock(async () => {
      throw new Error('boom');
    });
    await expect(withIdempotency('user-1', 'key-x', fn)).rejects.toThrow('boom');
    // Cache wasn't populated; a successful retry executes again.
    const ok = mock(async () => 'ok');
    const v = await withIdempotency('user-1', 'key-x', ok);
    expect(v).toBe('ok');
    expect(ok).toHaveBeenCalledTimes(1);
  });

  test('reset helper clears both cache and in-flight maps', async () => {
    const fn = mock(async () => 'v');
    await withIdempotency('user-1', 'key-x', fn);
    _resetIdempotencyCache();
    await withIdempotency('user-1', 'key-x', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
