import { afterAll, describe, expect, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import Decimal from 'decimal.js';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { HistoricalPriceBackfillService } from '../../../src/services/pricing/HistoricalPriceBackfillService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import {
  BenchmarkReturnService,
  measuredDayInstant,
} from '../../../src/services/returns/BenchmarkReturnService';
import { BackfillBenchmarkPricesUseCase } from '../../../src/use-cases/BackfillBenchmarkPricesUseCase';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

/**
 * SC-464. A benchmark is bought and held, so its return is end over start at
 * the instants the portfolio's first and last measured days were valued at.
 */

restoreContainerAfterAll();

const NOW = new Date('2026-09-19T12:00:00Z');

describe('measuredDayInstant', () => {
  test('a past day is its end, as the rollup values it', () => {
    expect(measuredDayInstant('2026-01-01', NOW).toISOString()).toBe('2026-01-01T23:59:59.999Z');
  });

  test('today is now', () => {
    expect(measuredDayInstant('2026-09-19', NOW)).toEqual(NOW);
  });
});

describe('BenchmarkReturnService.over', () => {
  const created: string[] = [];

  afterAll(async () => {
    if (created.length > 0)
      await db.delete(schema.tokens).where(inArray(schema.tokens.id, created));
  });

  test('end over start in the base currency, and null where a price is missing', async () => {
    const before = new Set(
      (
        await db
          .select({ id: schema.tokens.id })
          .from(schema.tokens)
          .where(inArray(schema.tokens.symbol, ['BTC', 'SPY']))
      ).map((r) => r.id)
    );
    Container.set(HistoricalPriceBackfillService, {
      backfillTokenRange: async () => ({
        inserted: 0,
        alreadyHad: 0,
        providerMissing: 0,
        providerUsed: null,
        attemptFailed: false,
      }),
    } as unknown as HistoricalPriceBackfillService);
    const [usd] = await db
      .select({ id: schema.tokens.id })
      .from(schema.tokens)
      .where(eq(schema.tokens.symbol, 'USD'))
      .limit(1);
    const ensured = await Container.get(BackfillBenchmarkPricesUseCase).execute({
      usdTokenId: usd?.id as string,
    });
    for (const r of ensured) if (!before.has(r.tokenId)) created.push(r.tokenId);
    const btc = ensured.find((r) => r.key === 'btc')?.tokenId;

    const asked: Array<{ token: string; at: string }> = [];
    Container.set(PriceGraphService, {
      convert: async (amount: Decimal, from: string, _to: string, at: Date) => {
        asked.push({ token: from, at: at.toISOString() });
        if (from !== btc) return null;
        const price = at.toISOString().startsWith('2026-01-01') ? 100 : 150;
        return { amount: new Decimal(amount).mul(price), stale: false };
      },
    } as unknown as PriceGraphService);

    const result = await new BenchmarkReturnService().over(
      { from: '2026-01-01', to: '2026-06-30' },
      'token-GBP',
      NOW
    );

    expect(result).toEqual([
      { key: 'btc', cumulative: '0.5' },
      { key: 'sp500', cumulative: null },
    ]);
    expect(asked.filter((a) => a.token === btc).map((a) => a.at)).toEqual([
      '2026-01-01T23:59:59.999Z',
      '2026-06-30T23:59:59.999Z',
    ]);
  });
});
