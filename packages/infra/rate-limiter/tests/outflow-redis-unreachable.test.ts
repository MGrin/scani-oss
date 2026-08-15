import { describe, expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { OutflowLimiterUnavailableError, RedisOutflowRateLimiter } from '../src/outflow/redis';

/**
 * SC-254, the sibling of SC-225.
 *
 * `tryAcquire` awaited `redis.eval` with no bound, on the shared connection
 * built `{ maxRetriesPerRequest: null }`. ioredis 5.10.1 only flushes the
 * command queue `if (typeof maxRetriesPerRequest === "number")`
 * (`built/redis/event_handler.js:199`), so `null` means a queued command is
 * never rejected — measured against a real client on a dead port, still
 * pending after 4000ms.
 *
 * **The old code does hang here, and these tests do catch it.** The stub is a
 * command that never settles, which is that exact shape. Against the previous
 * implementation every test below runs until bun's timeout and fails; the
 * elapsed-time assertions are the ones that would also catch a future
 * regression to an unbounded await without waiting for the harness to give up.
 *
 * **What they do NOT reproduce**: the ioredis behaviour itself. That was
 * established against a real client in SC-225 and is asserted nowhere in this
 * repo, because doing so needs a socket and a dead port. These tests assert
 * what this class does when a command does not settle — not that ioredis
 * produces that state.
 */

const NS = 'test-provider';

/** A Redis whose commands never settle — the offline queue of a connection
    that will never reject. */
function unreachableRedis(): Redis {
  return { eval: () => new Promise<never>(() => {}) } as unknown as Redis;
}

/** The same outage through a connection that DOES bound its retries. */
function rejectingRedis(): Redis {
  return {
    eval: () => Promise.reject(new Error('MaxRetriesPerRequestError')),
  } as unknown as Redis;
}

/** A healthy Redis that grants every slot. */
function healthyRedis(reply: number | string = 0): Redis {
  return { eval: () => Promise.resolve(reply) } as unknown as Redis;
}

function limiter(redis: Redis, timeoutMs = 20) {
  return new RedisOutflowRateLimiter({
    redis,
    namespace: NS,
    maxRequests: 5,
    windowMs: 60_000,
    timeoutMs,
  });
}

describe('a Redis that never answers', () => {
  test('execute() rejects instead of hanging', async () => {
    const started = performance.now();
    let threw: unknown;
    try {
      await limiter(unreachableRedis()).execute(async () => 'called upstream');
    } catch (error) {
      threw = error;
    }
    const elapsed = performance.now() - started;

    expect(threw).toBeInstanceOf(OutflowLimiterUnavailableError);
    // The old implementation returns here never.
    expect(elapsed).toBeLessThan(1_000);
  });

  test('the upstream call is never made', async () => {
    // The point of failing closed. If the work ran, we would have sent a
    // request against a budget nobody could check.
    let called = false;
    const l = limiter(unreachableRedis());

    await expect(
      l.execute(async () => {
        called = true;
        return 'sent';
      })
    ).rejects.toThrow(OutflowLimiterUnavailableError);

    expect(called).toBe(false);
  });

  test('it does not degrade to per-process counting', async () => {
    // The inflow limiter degrades and that is right for it — it protects our
    // own capacity, so N x the limit across N machines is a bounded,
    // self-inflicted loss. This one protects a third party's cap, where N x
    // is the exact failure the class exists to prevent and the penalty is a
    // ban we cannot lift. Five acquisitions under a max of 5 would all
    // succeed if it silently counted in-process; every one must refuse.
    const l = limiter(unreachableRedis());
    for (let i = 0; i < 5; i++) {
      await expect(l.execute(async () => i)).rejects.toThrow(OutflowLimiterUnavailableError);
    }
  });

  test('it does not report a wait the caller would sleep on', async () => {
    // `waitForSlot` loops on any non-zero return, so "fail closed" implemented
    // as a wait delta is the original hang with a sleep in it. `tryConsume`
    // is the only way to observe `tryAcquire`'s return directly — it must
    // throw here rather than answer `{ ok: false, retryAfterMs }`.
    const l = limiter(unreachableRedis());
    await expect(l.tryConsume()).rejects.toThrow(OutflowLimiterUnavailableError);
  });

  test('and never reports a slot it does not hold', async () => {
    const l = limiter(unreachableRedis());
    const result = await l.tryConsume().then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error) => ({ kind: 'rejected' as const, error })
    );
    // Explicitly not `{ ok: true }` — the failure mode that would let a caller
    // proceed against an unchecked budget.
    expect(result.kind).toBe('rejected');
  });

  test('the error names the namespace, so a log says which provider', async () => {
    const l = limiter(unreachableRedis());
    try {
      await l.tryConsume();
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(OutflowLimiterUnavailableError);
      expect((error as OutflowLimiterUnavailableError).namespace).toBe(NS);
      expect((error as Error).message).toContain(NS);
    }
  });
});

describe('a Redis that rejects', () => {
  test('a rejection fails closed the same way a timeout does', async () => {
    // A connection with a numeric `maxRetriesPerRequest` produces this shape
    // instead of a hang. Same absence of an answer, same refusal.
    const l = limiter(rejectingRedis());
    await expect(l.execute(async () => 'x')).rejects.toThrow(OutflowLimiterUnavailableError);
  });

  test('the original error is kept as `cause`', async () => {
    const l = limiter(rejectingRedis());
    try {
      await l.tryConsume();
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(((error as Error).cause as Error).message).toBe('MaxRetriesPerRequestError');
    }
  });
});

describe('a healthy Redis is untouched', () => {
  test('a granted slot runs the work', async () => {
    const l = limiter(healthyRedis(0));
    expect(await l.execute(async () => 'ran')).toBe('ran');
  });

  test('a string reply still parses — Lua returns integers as strings over some clients', async () => {
    const l = limiter(healthyRedis('0'));
    expect((await l.tryConsume()).ok).toBe(true);
  });

  test('a non-zero reply is a real wait, not an error', async () => {
    // The distinction the whole design rests on: "the budget is spent" is an
    // answer and must keep flowing through as one. Only "there was no answer"
    // throws.
    const l = limiter(healthyRedis(120));
    const result = await l.tryConsume();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryAfterMs).toBe(120);
  });
});
