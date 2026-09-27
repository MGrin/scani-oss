import { afterAll, describe, expect, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { BlsClient } from '@scani/providers/providers/bls';
import Decimal from 'decimal.js';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { HistoricalPriceBackfillService } from '../../../src/services/pricing/HistoricalPriceBackfillService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { BenchmarkReturnService } from '../../../src/services/returns/BenchmarkReturnService';
import { BackfillBenchmarkPricesUseCase } from '../../../src/use-cases/BackfillBenchmarkPricesUseCase';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

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

  test('converts days concurrently, and returns the same prices it did serially', async () => {
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

    let calls = 0;
    // Per BENCHMARK, not overall. `BENCHMARKS.map` has always run the two in
    // parallel, so an overall peak reads 2 on the serial day loop and an
    // assertion of "more than one in flight" passes without the change under
    // test — measured, this exact test passed against the `for` loop before
    // the counter was split. The day dimension is the one being changed, so
    // it is the one that has to be counted.
    const inFlight = new Map<string, number>();
    const peakPerToken = new Map<string, number>();
    Container.set(PriceGraphService, {
      convert: async (amount: Decimal, from: string, _to: string, at: Date) => {
        calls += 1;
        const n = (inFlight.get(from) ?? 0) + 1;
        inFlight.set(from, n);
        peakPerToken.set(from, Math.max(peakPerToken.get(from) ?? 0, n));
        await new Promise((r) => setTimeout(r, 2));
        inFlight.set(from, (inFlight.get(from) ?? 1) - 1);
        if (from !== btc) return null;
        // A price that varies by day, so a result mapped to the wrong day
        // would not silently agree.
        const day = Number(at.toISOString().slice(8, 10));
        return { amount: new Decimal(amount).mul(100 + day), stale: false };
      },
    } as unknown as PriceGraphService);

    const out = await new BenchmarkReturnService().pricesOn(DAYS, 'token-GBP', NOW);

    // CONTROL. With no benchmark token resolvable, `pricesOn` returns early
    // and every assertion below would hold vacuously — including the peak,
    // which reads 0. Assert the work HAPPENED before reading anything about
    // how it was scheduled.
    expect(calls).toBeGreaterThan(0);
    expect(btc).toBeTruthy();
    expect(peakPerToken.size).toBeGreaterThan(0);

    // The bound, read on the DAY dimension: within one benchmark, more than
    // one conversion is in flight — which the `for` loop cannot do — and
    // never more than the limit.
    for (const [token, peak] of peakPerToken) {
      expect({ token, peak: peak > 1 }).toEqual({ token, peak: true });
      expect(peak).toBeLessThanOrEqual(8);
    }

    // The numbers. Each day keeps the price computed from ITS OWN date, which
    // is the property a concurrent rewrite is most likely to break.
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
