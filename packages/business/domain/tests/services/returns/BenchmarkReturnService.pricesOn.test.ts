import { afterAll, describe, expect, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { BlsClient } from '@scani/providers/providers/bls';
import type Decimal from 'decimal.js';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { HistoricalPriceBackfillService } from '../../../src/services/pricing/HistoricalPriceBackfillService';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { BenchmarkReturnService } from '../../../src/services/returns/BenchmarkReturnService';
import { BackfillBenchmarkPricesUseCase } from '../../../src/use-cases/BackfillBenchmarkPricesUseCase';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { seriesFrom } from '../../../test/helpers/price-series';

restoreContainerAfterAll();

const NOW = new Date('2026-09-19T12:00:00Z');
const DAYS = Array.from(
  { length: 40 },
  (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, '0')}`
);

describe('BenchmarkReturnService.pricesOn', () => {
  const created: string[] = [];

  afterAll(async () => {
    if (created.length > 0)
      await db.delete(schema.tokens).where(inArray(schema.tokens.id, created));
  });

  test('one series for every benchmark and day, and each day keeps its own price', async () => {
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
    Container.set(BlsClient, { fetchMonthly: async () => [] } as unknown as BlsClient);
    const { prices: ensured } = await Container.get(BackfillBenchmarkPricesUseCase).execute({
      usdTokenId: usd?.id as string,
    });
    for (const r of ensured) if (!before.has(r.tokenId)) created.push(r.tokenId);
    const btc = ensured.find((r) => r.key === 'btc')?.tokenId;

    const loads: Array<ReadonlyArray<{ tokenId: string; at: Date }>> = [];
    Container.set(PriceReader, {
      series: async (asks: ReadonlyArray<{ tokenId: string; at: Date }>, base: string) => {
        loads.push(asks);
        return seriesFrom(asks, base, (amount: Decimal, from: string, _to: string, at: Date) => {
          if (from !== btc) return null;
          // A price that varies by day, so a result mapped to the wrong day
          // would not silently agree.
          return { amount: amount.mul(100 + Number(at.toISOString().slice(8, 10))), stale: false };
        });
      },
    } as unknown as PriceReader);

    const out = await new BenchmarkReturnService().pricesOn(DAYS, 'token-GBP', NOW);

    // CONTROL. With no benchmark token resolvable, `pricesOn` returns early
    // and every assertion below would hold vacuously. Assert the work
    // HAPPENED before reading anything about how it was loaded.
    expect(btc).toBeTruthy();
    expect(loads).toHaveLength(1);
    const btcInstants = (loads[0] ?? []).filter((ask) => ask.tokenId === btc);
    expect(new Set(btcInstants.map((ask) => ask.at.getTime())).size).toBe(new Set(DAYS).size);

    // The numbers. Each day keeps the price computed from ITS OWN date.
    const btcPrices = out.get('btc');
    expect(btcPrices?.size).toBe(new Set(DAYS).size);
    for (const day of new Set(DAYS)) {
      const expected = 100 + Number(day.slice(8, 10));
      expect(btcPrices?.get(day)?.toString()).toBe(String(expected));
    }

    // sp500 resolves a token but every conversion returns null, so it is
    // absent rather than present-and-empty.
    expect(out.has('sp500')).toBe(false);
  });
});
