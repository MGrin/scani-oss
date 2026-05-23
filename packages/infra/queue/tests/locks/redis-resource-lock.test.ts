import { describe, expect, test } from 'bun:test';
import { RedisResourceLock } from '../../src/locks/redis-resource-lock';

interface SetCall {
  key: string;
  value: string;
  px: 'PX';
  ttl: number;
  nx: 'NX';
}

function makeStubRedis(setReturns: Array<'OK' | null>) {
  const setCalls: SetCall[] = [];
  const delCalls: string[] = [];
  let i = 0;
  return {
    setCalls,
    delCalls,
    redis: {
      set: (key: string, value: string, px: 'PX', ttl: number, nx: 'NX') => {
        setCalls.push({ key, value, px, ttl, nx });
        return setReturns[i++] ?? null;
      },
      del: (key: string) => {
        delCalls.push(key);
        return 1;
      },
    },
  };
}

describe('RedisResourceLock', () => {
  test('acquires when SET NX returns OK', async () => {
    const { redis, setCalls } = makeStubRedis(['OK']);
    const lock = new RedisResourceLock();
    lock.configure(redis as never);
    const result = await lock.acquire('key-1', 30_000);
    expect(result.ok).toBe(true);
    expect(setCalls).toEqual([{ key: 'key-1', value: '1', px: 'PX', ttl: 30_000, nx: 'NX' }]);
  });

  test('returns busy when SET NX returns null (already locked)', async () => {
    const { redis } = makeStubRedis([null]);
    const lock = new RedisResourceLock();
    lock.configure(redis as never);
    const result = await lock.acquire('key-1', 30_000);
    expect(result.ok).toBe(false);
  });

  test('release deletes the key', async () => {
    const { redis, delCalls } = makeStubRedis(['OK']);
    const lock = new RedisResourceLock();
    lock.configure(redis as never);
    const result = await lock.acquire('held', 1000);
    if (!result.ok) throw new Error('expected ok');
    await result.release();
    expect(delCalls).toEqual(['held']);
  });

  test('release swallows errors (TTL will clean up anyway)', async () => {
    const lock = new RedisResourceLock();
    lock.configure({
      set: () => 'OK',
      del: () => {
        throw new Error('redis down');
      },
    } as never);
    const result = await lock.acquire('held', 1000);
    if (!result.ok) throw new Error('expected ok');
    await expect(result.release()).resolves.toBeUndefined();
  });

  test('throws when used before configure', async () => {
    const lock = new RedisResourceLock();
    await expect(lock.acquire('key', 100)).rejects.toThrow(/not configured/);
  });
});
