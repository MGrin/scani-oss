/**
 * The nightly historical backfill prices everything against USD (foundation
 * A3, Task 7). Both use cases write against the base id they are handed, so
 * the id is what is asserted; they are stubbed, because the real ones walk
 * every user in the database.
 *
 * The crypto token named USD is committed, as the processor reads through the
 * global connection, and removed after each test.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { makeToken, restoreContainerAfterAll, withoutFiatUsd } from '@scani/domain/test-helpers';
import {
  BackfillBenchmarkPricesUseCase,
  BackfillHistoricalPricesUseCase,
} from '@scani/domain/use-cases';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Container } from 'typedi';
import { HistoricalPriceBackfillProcessor } from '../../src/processors/historical-price-backfill';

restoreContainerAfterAll();

const made: string[] = [];

afterEach(async () => {
  const tokens = made.splice(0);
  if (tokens.length > 0) {
    await getDb().delete(schema.tokens).where(inArray(schema.tokens.id, tokens));
  }
});

async function fiatUsdId(): Promise<string> {
  const [usd] = await getDb()
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
    .where(
      and(
        eq(schema.tokens.symbol, 'USD'),
        eq(schema.tokenTypes.code, 'fiat'),
        isNull(schema.tokens.marketSegment)
      )
    );
  if (!usd) throw new Error('the fiat USD is seeded by migration');
  return usd.id;
}

type Summary = Awaited<ReturnType<BackfillHistoricalPricesUseCase['execute']>>;

/** What a run with nothing to backfill returns. */
const NOTHING_TO_DO: Summary = {
  attempted: 0,
  inserted: 0,
  alreadyHad: 0,
  providerMissing: 0,
  droppedDays: 0,
  droppedBars: 0,
  skippedUnpriceable: 0,
  attemptsFailed: 0,
  durationMs: 0,
};

/** Both use cases replaced by recorders of the base they were handed. */
function recordBases(summary: Summary = NOTHING_TO_DO): Array<[string, string]> {
  const bases: Array<[string, string]> = [];
  Container.set(BackfillHistoricalPricesUseCase, {
    execute: async (opts: { usdTokenId: string }) => {
      bases.push(['held tokens', opts.usdTokenId]);
      return summary;
    },
  } as unknown as BackfillHistoricalPricesUseCase);
  Container.set(BackfillBenchmarkPricesUseCase, {
    execute: async (opts: { usdTokenId: string }) => {
      bases.push(['benchmarks', opts.usdTokenId]);
      return { prices: [], inflation: null };
    },
  } as unknown as BackfillBenchmarkPricesUseCase);
  return bases;
}

async function runProcessor(processor = new HistoricalPriceBackfillProcessor()): Promise<void> {
  // `handle` is protected; the scheduled-job base calls it inside the lock.
  await (processor as unknown as { handle: () => Promise<void> }).handle();
}

describe('HistoricalPriceBackfillProcessor', () => {
  test('the historical backfill writes against the fiat USD', async () => {
    const usdId = await fiatUsdId();
    // Created now, and so after the fiat.
    const coin = await getDb().transaction((tx) =>
      makeToken(tx, { symbol: 'USD', name: 'A coin named USD' })
    );
    made.push(coin.id);
    const bases = recordBases();

    await runProcessor();

    expect(bases).toEqual([
      ['held tokens', usdId],
      ['benchmarks', usdId],
    ]);
  });

  test('the completion line carries the days and bars the writer dropped', async () => {
    recordBases({
      ...NOTHING_TO_DO,
      attempted: 9,
      inserted: 4,
      providerMissing: 2,
      droppedDays: 3,
      droppedBars: 5,
    });
    const processor = new HistoricalPriceBackfillProcessor();
    // `logger` is private so the processor owns its component name.
    const { logger } = processor as unknown as {
      logger: { info: (context: unknown, message?: string) => void };
    };
    const info = spyOn(logger, 'info').mockImplementation(() => {});
    try {
      await runProcessor(processor);

      const completion = info.mock.calls.find(
        ([, message]) => message === '✅ Historical price backfill complete'
      );
      expect(completion?.[0]).toMatchObject({
        attempted: 9,
        inserted: 4,
        providerMissing: 2,
        droppedDays: 3,
        droppedBars: 5,
      });
    } finally {
      info.mockRestore();
    }
  });

  // A catalogue with no fiat USD is a broken install. The job skipped
  // quietly, which hid it. The resolver here is one that finds none: no
  // catalogue row changes, so a killed run leaves the database whole.
  test('with no fiat USD in the catalogue the historical backfill throws, naming the token', async () => {
    const restore = withoutFiatUsd();
    try {
      recordBases();

      await expect(runProcessor()).rejects.toThrow('no fiat USD token');
    } finally {
      restore();
    }
  });
});
