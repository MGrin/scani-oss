import { expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { ProcessingGuard } from '../../src/usage/processing-guard';

function store() {
  const rows = new Map<string, string>();
  return {
    rows,
    redis: {
      get: async (k: string) => rows.get(k) ?? null,
      set: async (k: string, v: string, ...args: unknown[]) => {
        if (args.includes('NX') && rows.has(k)) return null;
        rows.set(k, v);
        return 'OK';
      },
      eval: async (script: string, _count: number, key: string, marker: string, result: string) => {
        if (!script.includes("redis.call('GET'")) return 0;
        if (rows.get(key) !== marker) return null;
        rows.set(key, result);
        return 'OK';
      },
    } as unknown as Redis,
  };
}
test('replays successful paid work only for the same owner and input', async () => {
  const { redis } = store();
  const guard = new ProcessingGuard();
  let calls = 0;
  const work = async () => ({ answer: ++calls });
  expect((await guard.run(redis, 'owner-a', 'ai', { prompt: 'hello' }, work)).replayed).toBe(false);
  expect((await guard.run(redis, 'owner-a', 'ai', { prompt: 'hello' }, work)).result.answer).toBe(
    1
  );
  expect((await guard.run(redis, 'owner-b', 'ai', { prompt: 'hello' }, work)).result.answer).toBe(
    2
  );
  expect(calls).toBe(2);
});
test('uncertain failures and concurrent duplicates do not spend twice', async () => {
  const { redis } = store();
  const guard = new ProcessingGuard();
  let calls = 0;
  const work = async () => {
    calls++;
    throw new Error('vendor secret must not escape');
  };
  await expect(guard.run(redis, 'owner', 'ai', {}, work)).rejects.toThrow(
    'Cloud processing failed'
  );
  await expect(guard.run(redis, 'owner', 'ai', {}, work)).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  expect(calls).toBe(1);
  await expect(guard.run(null, 'owner', 'ai', {}, work)).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
});

test('concurrent identical operations cannot both reach the upstream', async () => {
  const { redis } = store();
  const guard = new ProcessingGuard();
  let release: () => void = () => {};
  const ready = Promise.withResolvers<void>();
  const first = guard.run(redis, 'concurrent-owner', 'ai', {}, async () => {
    ready.resolve();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return 'done';
  });
  await ready.promise;
  await expect(
    guard.run(redis, 'concurrent-owner', 'ai', {}, async () => 'duplicate')
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  release();
  expect((await first).result).toBe('done');
});
test('owner rate refusal stops paid work', async () => {
  const { redis } = store();
  redis.eval = (async () => 1000) as Redis['eval'];
  let spent = false;
  await expect(
    new ProcessingGuard().run(redis, 'limited-owner', 'ai', {}, async () => {
      spent = true;
    })
  ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  expect(spent).toBe(false);
});

test('a replay cache outage preserves a completed result for usage accounting', async () => {
  const { redis } = store();
  const originalEval = redis.eval.bind(redis);
  redis.eval = (async (...args: Parameters<Redis['eval']>) => {
    if (String(args[0]).includes("redis.call('GET'")) throw new Error('cache unavailable');
    return originalEval(...args);
  }) as Redis['eval'];
  const result = await new ProcessingGuard().run(redis, 'owner', 'ai', {}, async () => ({
    data: 'done',
    usage: { upstreamCostUsd: 0.01 },
  }));
  expect(result).toEqual({
    result: { data: 'done', usage: { upstreamCostUsd: 0.01 } },
    replayed: false,
  });
  await expect(
    new ProcessingGuard().run(redis, 'owner', 'ai', {}, async () => 'duplicate')
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

test('a hung replay cache cannot prevent completed usage returning', async () => {
  const { redis } = store();
  redis.eval = (async (script: string) =>
    script.includes("redis.call('GET'") ? new Promise(() => {}) : 0) as unknown as Redis['eval'];
  const outcome = await new ProcessingGuard().run(redis, 'hung-cache', 'ai', {}, async () => ({
    usage: { upstreamCostUsd: 0.1 },
  }));
  expect(outcome.result.usage.upstreamCostUsd).toBe(0.1);
});

test('a delayed claim acknowledgement never dispatches paid work', async () => {
  const { redis } = store();
  const claim = Promise.withResolvers<string>();
  redis.set = (() => claim.promise) as Redis['set'];
  let calls = 0;
  await expect(
    new ProcessingGuard().run(redis, 'hung-claim', 'ai', {}, async () => {
      calls++;
    })
  ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  claim.resolve('OK');
  await Bun.sleep(1);
  expect(calls).toBe(0);
});
