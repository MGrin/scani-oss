import { describe, expect, test } from 'bun:test';
import { type PingableRedis, pingWithin, RedisPingTimeoutError } from '../src/ping-within';

/**
 * SC-294. `/health/deep` did `await redisConnection.ping()` with no bound.
 *
 * ioredis queues a command issued while the connection is down and resolves it
 * when the connection returns — which, on a machine whose Redis host does not
 * resolve, is never. So the endpoint did not fail, it HUNG, until Fly's proxy
 * gave up at ~31s and returned a 502 with no body.
 *
 * The cost was not the latency. `/health/deep` reports `redisReachability`
 * (SC-225) precisely to say whether an unreachable Redis is the kind that
 * self-heals — and that field had never once been read during an occurrence,
 * because the deploy smoke fetches its body with `curl --max-time 10` and got
 * an empty string every time. The endpoint carrying the diagnosis could not
 * deliver it during the failure it describes.
 */

/** A ping that never settles — the production shape, not an error. */
const neverSettles: PingableRedis = { ping: () => new Promise<string>(() => {}) };

describe('the bound', () => {
  test('THE DEFECT: a ping that never settles rejects instead of hanging', async () => {
    const started = performance.now();
    await expect(pingWithin(neverSettles, 25)).rejects.toBeInstanceOf(RedisPingTimeoutError);
    // Bounded by its own deadline, not by a proxy 31 seconds away.
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('the error says how long it waited, so a reader can tell it from a refusal', async () => {
    // This string reaches `/health/deep`'s `checks.redis.error`, and from
    // there the smoke's failure report. "timed out after 2000ms" and
    // "connect ECONNREFUSED" must not read the same.
    const err = await pingWithin(neverSettles, 25).catch((e) => e);
    expect(err).toBeInstanceOf(RedisPingTimeoutError);
    expect((err as RedisPingTimeoutError).message).toBe('ping timed out after 25ms');
    expect((err as RedisPingTimeoutError).timeoutMs).toBe(25);
  });
});

describe('THE SUCCESS PATH — asserted deliberately', () => {
  // #834 shipped broken because only its refusal paths were tested.
  test('a healthy ping returns PONG', async () => {
    const redis: PingableRedis = { ping: async () => 'PONG' };
    expect(await pingWithin(redis, 2_000)).toBe('PONG');
  });

  test('a slow-but-answering ping still succeeds inside the bound', async () => {
    // Production latency here is 1ms; the bound is 2000ms. A check that
    // failed on ordinary slowness would 503 a healthy fleet mid-deploy.
    const redis: PingableRedis = {
      ping: () => new Promise((resolve) => setTimeout(() => resolve('PONG'), 20)),
    };
    expect(await pingWithin(redis, 500)).toBe('PONG');
  });

  test('an unexpected reply is passed through, not swallowed', async () => {
    // The caller distinguishes `PONG` from anything else itself; this must
    // not turn a weird reply into a timeout.
    const redis: PingableRedis = { ping: async () => 'WAT' };
    expect(await pingWithin(redis, 500)).toBe('WAT');
  });
});

describe('NEGATIVE CONTROL — a real error is not converted into a timeout', () => {
  test('a rejecting ping rejects with its own error', async () => {
    // The control that gives the first block meaning: if every failure came
    // back as RedisPingTimeoutError, the bound would be erasing exactly the
    // distinction SC-225 added the reachability field to preserve.
    const boom = new Error('connect ECONNREFUSED 127.0.0.1:6379');
    const redis: PingableRedis = { ping: () => Promise.reject(boom) };
    await expect(pingWithin(redis, 5_000)).rejects.toBe(boom);
  });

  test('and it rejects immediately rather than waiting out the bound', async () => {
    const started = performance.now();
    const redis: PingableRedis = { ping: () => Promise.reject(new Error('nope')) };
    await pingWithin(redis, 10_000).catch(() => undefined);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('it does not leak', () => {
  test('a ping that settles late does not raise an unhandled rejection', async () => {
    // ioredis settles the queued command eventually. An unhandled rejection
    // surfacing minutes later, attributed to nothing, is its own bug.
    let rejectLate: ((e: Error) => void) | undefined;
    const redis: PingableRedis = {
      ping: () =>
        new Promise<string>((_, reject) => {
          rejectLate = reject;
        }),
    };
    await expect(pingWithin(redis, 10)).rejects.toBeInstanceOf(RedisPingTimeoutError);

    let unhandled: unknown;
    const onUnhandled = (e: unknown) => {
      unhandled = e;
    };
    process.on('unhandledRejection', onUnhandled);
    rejectLate?.(new Error('settled long after the health check gave up'));
    await new Promise((r) => setTimeout(r, 50));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toBeUndefined();
  });
});
