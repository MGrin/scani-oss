import { afterAll, describe, expect, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Container } from 'typedi';
import { HistoricalPriceBackfillService } from '../../src/services/pricing/HistoricalPriceBackfillService';
import { BackfillBenchmarkPricesUseCase } from '../../src/use-cases/BackfillBenchmarkPricesUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

/**
 * SC-464. The benchmark history is fetched whether or not anyone holds the
 * asset, into a token row that is reused rather than duplicated.
 */

restoreContainerAfterAll();

const calls: Array<{ tokenId: string; baseTokenId: string; days: Date[] }> = [];
Container.set(HistoricalPriceBackfillService, {
  backfillTokenRange: async (tokenId: string, baseTokenId: string, days: Date[]) => {
    calls.push({ tokenId, baseTokenId, days });
    return {
      inserted: 0,
      alreadyHad: 0,
      providerMissing: 0,
      providerUsed: null,
      attemptFailed: false,
    };
  },
} as unknown as HistoricalPriceBackfillService);

async function benchmarkTokenIds(): Promise<{ btc: string[]; spy: string[] }> {
  const types = await db
    .select()
    .from(schema.tokenTypes)
    .where(inArray(schema.tokenTypes.code, ['crypto', 'stock']));
  const crypto = types.find((t) => t.code === 'crypto')?.id as string;
  const stock = types.find((t) => t.code === 'stock')?.id as string;
  const btc = await db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(
      and(
        eq(schema.tokens.symbol, 'BTC'),
        eq(schema.tokens.typeId, crypto),
        isNull(schema.tokens.marketSegment)
      )
    );
  const spy = await db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(
      and(
        eq(schema.tokens.symbol, 'SPY'),
        eq(schema.tokens.typeId, stock),
        eq(schema.tokens.marketSegment, 'US')
      )
    );
  return { btc: btc.map((r) => r.id), spy: spy.map((r) => r.id) };
}

const before = await benchmarkTokenIds();
const [usd] = await db
  .select({ id: schema.tokens.id })
  .from(schema.tokens)
  .where(eq(schema.tokens.symbol, 'USD'))
  .limit(1);
const USD = usd?.id as string;

afterAll(async () => {
  const after = await benchmarkTokenIds();
  const created = [...after.btc, ...after.spy].filter(
    (id) => ![...before.btc, ...before.spy].includes(id)
  );
  if (created.length > 0) await db.delete(schema.tokens).where(inArray(schema.tokens.id, created));
});

describe('BackfillBenchmarkPricesUseCase (SC-464)', () => {
  test('asks for USD history of BTC and SPY, creating a token nobody held', async () => {
    const results = await Container.get(BackfillBenchmarkPricesUseCase).execute({
      usdTokenId: USD,
    });
    const after = await benchmarkTokenIds();
    expect(after.btc.length).toBeGreaterThan(0);
    expect(after.spy.length).toBeGreaterThan(0);
    expect(results.map((r) => r.key)).toEqual(['btc', 'sp500']);
    expect(calls.map((c) => c.baseTokenId)).toEqual([USD, USD]);
    expect(calls.map((c) => c.tokenId)).toEqual(results.map((r) => r.tokenId));
  });

  test('a second run reuses the same tokens rather than creating more', async () => {
    const first = await benchmarkTokenIds();
    await Container.get(BackfillBenchmarkPricesUseCase).execute({
      usdTokenId: USD,
    });
    const second = await benchmarkTokenIds();
    expect(second).toEqual(first);
  });
});
