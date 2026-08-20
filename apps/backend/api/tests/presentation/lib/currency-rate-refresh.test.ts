process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import type { CURRENCY_RATE_REFRESH } from '@scani/jobs';
import { BullMqEnqueueService } from '@scani/queue';
import { Container } from 'typedi';
import { enqueueCurrencyRateRefresh } from '../../../src/presentation/lib/currency-rate-refresh';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * The other half of the SC-222 trade: the read returns without the pair, and
 * this asks the worker to go and get it.
 *
 * What these tests actually protect is the platform, not the figure. The
 * fetch this queues sits behind an outflow limiter of two requests per sixty
 * seconds, so the failure mode is not a slow job — it is one queued upstream
 * call per user per currency after a deploy empties the api's memory cache,
 * against a budget of two a minute. The jobId is what makes that impossible.
 */

interface Added {
  jobId: string | undefined;
  payload: { fromSymbol: string; toSymbol: string; userId: string };
}

// Currency refs as the router hands them over: a `tokens` row id plus what to
// call it. `SOS` deliberately appears twice, on two different ids — that pair
// is the whole of SC-223 and the reason this helper dedupes on id.
const USD = { id: '00000000-0000-4000-8000-0000000000us', symbol: 'USD' };
const GBP = { id: '00000000-0000-4000-8000-0000000000gb', symbol: 'GBP' };
const IDR = { id: '00000000-0000-4000-8000-0000000000id', symbol: 'IDR' };
const SOS_FIAT = { id: '00000000-0000-4000-8000-0000000000s1', symbol: 'SOS' };
const SOS_MEME = { id: '00000000-0000-4000-8000-0000000000s2', symbol: 'SOS' };

function stubQueue(onAdd?: () => never): Added[] {
  const added: Added[] = [];
  Container.set(BullMqEnqueueService, {
    add: async (descriptor: typeof CURRENCY_RATE_REFRESH, payload: never) => {
      onAdd?.();
      added.push({ jobId: descriptor.computeJobId?.(payload), payload });
      return { id: 'job' } as never;
    },
  } as unknown as BullMqEnqueueService);
  return added;
}

describe('enqueueCurrencyRateRefresh', () => {
  test('queues one refresh per missing currency, into the caller base', async () => {
    const added = stubQueue();
    await enqueueCurrencyRateRefresh('user-1', USD, [GBP, IDR]);

    expect(added.map((a) => `${a.payload.fromSymbol}->${a.payload.toSymbol}`)).toEqual([
      'GBP->USD',
      'IDR->USD',
    ]);
  });

  test('nothing missing means no queue traffic at all', async () => {
    const added = stubQueue();
    await enqueueCurrencyRateRefresh('user-1', USD, []);
    expect(added).toEqual([]);
  });

  test('the same pair from two different users computes ONE job id', async () => {
    // The thundering herd, in miniature. A rate is not per-user, so two users
    // whose Money tab misses GBP must not queue two upstream calls — at two
    // requests a minute the second is a wasted slot the next pair needed.
    const added = stubQueue();
    await enqueueCurrencyRateRefresh('user-1', USD, [GBP]);
    await enqueueCurrencyRateRefresh('user-2', USD, [GBP]);

    expect(added).toHaveLength(2);
    expect(added[0]?.jobId).toBe(added[1]?.jobId as string);
    // BullMQ drops the second by id; the assertion above is what makes that
    // true, so it is the one worth pinning rather than the drop itself.
    expect(added[0]?.jobId).toContain(GBP.id);
  });

  test('different pairs do not collide', async () => {
    const added = stubQueue();
    await enqueueCurrencyRateRefresh('user-1', USD, [GBP, IDR]);
    expect(added[0]?.jobId).not.toBe(added[1]?.jobId as string);
  });

  test('a duplicate currency in one call is queued once', async () => {
    const added = stubQueue();
    await enqueueCurrencyRateRefresh('user-1', USD, [GBP, GBP]);
    expect(added).toHaveLength(1);
  });

  test('two rows sharing a ticker are two pairs, not one', async () => {
    // Dedup is on the token id. Keyed on the symbol, the Somali shilling and
    // the memecoin would collapse into one job and one of them would never be
    // refreshed — which is the same wrong-row defect one layer out (SC-223).
    const added = stubQueue();
    await enqueueCurrencyRateRefresh('user-1', USD, [SOS_FIAT, SOS_MEME]);

    expect(added).toHaveLength(2);
    expect(added[0]?.jobId).not.toBe(added[1]?.jobId as string);
  });

  test('a queue that is down does not fail the read it was called from', async () => {
    // The figure has already been computed and is on its way to the browser.
    // Throwing here would turn a partial total into an error page, which is
    // the opposite of the trade this whole change makes.
    stubQueue(() => {
      throw new Error('redis is gone');
    });
    await expect(enqueueCurrencyRateRefresh('user-1', USD, [GBP])).resolves.toBeUndefined();
  });
});
