import { describe, expect, test } from 'bun:test';
import { StoreCommandTimeoutError, withDeadline } from '../src/deadline';

/**
 * SC-522. The bound that three call sites had each written for themselves
 * (`inflow/redis.ts`, `outflow/redis.ts`, `ping-within.ts`) and a fourth
 * (`PortfolioValueCache`) had not written at all — which is what let the
 * portfolio page hang forever on a Redis that was merely absent.
 *
 * The three details asserted below are not stylistic. Each was a real defect
 * somewhere before it was a rule, and none of them is visible by reading the
 * function.
 */
describe('withDeadline', () => {
  const never = () => new Promise<never>(() => {});

  test('rejects with the caller-supplied error when the bound wins', async () => {
    const started = performance.now();
    await expect(
      withDeadline(never(), 25, () => new StoreCommandTimeoutError('redis', 'GET', 25))
    ).rejects.toBeInstanceOf(StoreCommandTimeoutError);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('the error names the operation and the wait, so a log can tell it from a refusal', async () => {
    // "redis GET timed out after 25ms" and "connect ECONNREFUSED" describe
    // different things to whoever reads the log. Reporting them identically is
    // what made a stranded connection look like a deploy in progress (SC-225).
    const err = await withDeadline(
      never(),
      25,
      () => new StoreCommandTimeoutError('redis', 'GET', 25)
    ).catch((e) => e);
    expect((err as StoreCommandTimeoutError).message).toBe('redis GET timed out after 25ms');
    expect((err as StoreCommandTimeoutError).operation).toBe('GET');
    expect((err as StoreCommandTimeoutError).timeoutMs).toBe(25);
  });

  test('the store is named by the caller, so the message points at the right dependency', () => {
    // SC-578. The class used to hardcode `redis`, and `bullmq-enqueue-service`
    // went on raising `redis enqueue timed out` for a `pg` query after SC-518
    // moved the queue to Postgres — sending an operator to look at a Redis
    // that was perfectly healthy.
    //
    // Asserted as the POSITIVE message rather than as "does not contain
    // redis". An absence guard here would go vacuous the day the message stops
    // naming a store for any reason at all, and it would still pass; this one
    // can only pass while the store really is interpolated.
    expect(new StoreCommandTimeoutError('postgres', 'enqueue', 10_000).message).toBe(
      'postgres enqueue timed out after 10000ms'
    );
    expect(new StoreCommandTimeoutError('redis', 'GET', 250).message).toBe(
      'redis GET timed out after 250ms'
    );
    expect(new StoreCommandTimeoutError('postgres', 'enqueue', 10_000).store).toBe('postgres');
  });

  test('a late rejection from the losing promise is not unhandled', async () => {
    // The timed-out command is NOT cancelled — neither ioredis nor `pg` offers
    // that — so it stays live and may reject long after the race is settled. Without the
    // no-op catch inside `withDeadline` that surfaces as an unhandled
    // rejection attributed to nothing, minutes away from its cause.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const late = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('getaddrinfo ENOTFOUND')), 10);
      });
      await expect(
        withDeadline(late, 1, () => new StoreCommandTimeoutError('redis', 'GET', 1))
      ).rejects.toBeInstanceOf(StoreCommandTimeoutError);
      await new Promise((r) => setTimeout(r, 60));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  /**
   * **Do not delete these.** They look like "a promise that resolves,
   * resolves". They are the reason the bound is a bound and not a break.
   *
   * A timeout is a discriminator, and the case it must NOT fire on — a
   * dependency that is alive and merely slower than instant — looks identical
   * to the one it must fire on until the deadline passes. A bound that fired
   * on everything would satisfy every test above this block, and would take
   * the rate limiters to their fallback and the portfolio cache to a recompute
   * on every single request, forever. That is a worse outage than the hang.
   */
  describe('the benign case that shares the signal', () => {
    test('work that settles inside the bound resolves normally', async () => {
      const value = await withDeadline(
        Promise.resolve('PONG'),
        1_000,
        () => new StoreCommandTimeoutError('redis', 'PING', 1_000)
      );
      expect(value).toBe('PONG');
    });

    test('work that is SLOW but inside the bound still resolves, not times out', async () => {
      const slow = new Promise<string>((r) => setTimeout(() => r('PONG'), 60));
      const value = await withDeadline(
        slow,
        1_000,
        () => new StoreCommandTimeoutError('redis', 'PING', 1_000)
      );
      expect(value).toBe('PONG');
    });

    test("work's own rejection is passed through, not replaced by the timeout error", async () => {
      // A connection that DOES bound its retries rejects with
      // `MaxRetriesPerRequestError`. Callers distinguish the two shapes; a
      // bound that swallowed the real cause would erase that.
      const err = await withDeadline(
        Promise.reject(new Error('getaddrinfo ENOTFOUND')),
        1_000,
        () => new StoreCommandTimeoutError('redis', 'GET', 1_000)
      ).catch((e) => e);
      expect((err as Error).message).toBe('getaddrinfo ENOTFOUND');
      expect(err).not.toBeInstanceOf(StoreCommandTimeoutError);
    });
  });
});
