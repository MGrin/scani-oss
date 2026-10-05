/**
 * Characterization (foundation A3, Task 6): the rows the historical backfill
 * stores, through a real database, through
 * `PriceWriter`. The unit tests beside this stub the write; these do not.
 *
 * The service writes through the global connection, so every row here is
 * committed and removed after each test.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import type { Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import type { HistoricalPriceProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { PriceQuote } from '@scani/providers/core/types';
import { asc, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HistoricalPriceBackfillService } from '../../../src/services/pricing/HistoricalPriceBackfillService';
import { committedRows, dropPricesOf } from '../../../test/helpers/committed-rows';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { makeToken } from '../../../test/helpers/factories-extra';

restoreContainerAfterAll();

const DAY = 24 * 60 * 60 * 1000;

const rows = committedRows();
let fiatTypeId: string;

beforeAll(async () => {
  const [fiat] = await getDb()
    .select({ id: schema.tokenTypes.id })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, 'fiat'));
  if (!fiat) throw new Error('the fiat token type is seeded by migration');
  fiatTypeId = fiat.id;
});

afterEach(async () => {
  await dropPricesOf(rows.tokens);
  await rows.drop();
});

async function commitFiat(): Promise<Token> {
  const token = await getDb().transaction((tx) => makeToken(tx, { typeId: fiatTypeId }));
  rows.tokens.push(token.id);
  return token;
}

function storedFor(tokenId: string) {
  return getDb()
    .select()
    .from(schema.tokenPrices)
    .where(eq(schema.tokenPrices.tokenId, tokenId))
    .orderBy(asc(schema.tokenPrices.timestamp));
}

/** A backfill whose only historical provider answers from `quote` and `range`. */
function backfill(provider: {
  quote?: (token: Token, at: Date) => PriceQuote | null;
  range?: (token: Token, from: Date, to: Date) => PriceQuote[];
}): HistoricalPriceBackfillService {
  const fx: HistoricalPriceProvider = {
    providerKey: 'test-fx',
    capabilities: ['historical-price'],
    canPrice: () => true,
    fetchCurrentPrice: async () => null,
    fetchHistoricalPrice: async (token, at) => provider.quote?.(token, at) ?? null,
    ...(provider.range
      ? { fetchHistoricalRange: async (token, from, to) => provider.range?.(token, from, to) ?? [] }
      : {}),
  };
  const registry = new ProviderRegistry();
  registry.register(fx);
  Container.set(ProviderRegistry, registry);
  return new HistoricalPriceBackfillService();
}

describe('HistoricalPriceBackfillService writes', () => {
  test('a range lands as daily rows at the provider’s stamps, under its source, against the base asked', async () => {
    const currency = await commitFiat();
    const base = await commitFiat();
    const first = new Date('2026-02-02T00:00:00.000Z');
    const days = [0, 1, 2].map((k) => new Date(first.getTime() + k * DAY));
    const prices = ['1.1', '1.2', '1.3'];
    // The provider stamps its bars at 16:00, not at the days asked.
    const stamp = (day: Date) => new Date(day.getTime() + 16 * 60 * 60 * 1000);
    const service = backfill({
      range: (token) =>
        days.map((day, k) => ({
          tokenId: token.id,
          baseTokenId: base.id,
          price: prices[k] ?? '',
          timestamp: stamp(day),
          source: 'test-fx_historical',
        })),
    });

    const result = await service.backfillTokenRange(currency.id, base.id, days);

    expect(result).toMatchObject({ inserted: 3, providerMissing: 0, providerUsed: 'test-fx' });
    const stored = await storedFor(currency.id);
    expect(
      stored.map((r) => [r.baseTokenId, r.price, r.timestamp.getTime(), r.granularity, r.source])
    ).toEqual(
      days.map((day, k) => [
        base.id,
        prices[k] ?? '',
        stamp(day).getTime(),
        'daily',
        'test-fx_historical',
      ])
    );
  });

  // A dropped bar's day is neither inserted nor missing: the provider answered
  // it, so the unpriceable flag, which reads `providerMissing`, sees what it did.
  test('a bar the writer drops is counted dropped, never inserted, and its day is not missing', async () => {
    const currency = await commitFiat();
    const base = await commitFiat();
    const first = new Date('2026-02-02T00:00:00.000Z');
    const days = [0, 1, 2, 3].map((k) => new Date(first.getTime() + k * DAY));
    const prices = ['1.5', '0', '-1'];
    const service = backfill({
      // Bars for the first three days; the fourth has none.
      range: (token) =>
        days.slice(0, 3).map((day, k) => ({
          tokenId: token.id,
          baseTokenId: base.id,
          price: prices[k] ?? '',
          timestamp: day,
          source: 'test-fx_historical',
        })),
    });

    const result = await service.backfillTokenRange(currency.id, base.id, days);

    expect(result).toMatchObject({
      inserted: 1,
      droppedDays: 2,
      droppedBars: 2,
      providerMissing: 1,
      alreadyHad: 0,
    });
    expect((await storedFor(currency.id)).map((r) => r.price)).toEqual(['1.5']);
  });

  // Days and bars are different units: `inserted` and `providerMissing` count
  // needed days, so a dropped day is one too, and every needed day is exactly
  // one of the four. A bar dropped on a day nobody asked for is a bar only.
  test('a needed day whose bars were all dropped is one dropped day; a bar on a day not asked is a dropped bar only', async () => {
    const currency = await commitFiat();
    const base = await commitFiat();
    const first = new Date('2026-02-02T00:00:00.000Z');
    const days = [0, 1, 2, 3].map((k) => new Date(first.getTime() + k * DAY));
    const bar = (at: number, price: string) => ({
      tokenId: currency.id,
      baseTokenId: base.id,
      price,
      timestamp: new Date(at),
      source: 'test-fx_historical',
    });
    const service = backfill({
      range: () => [
        bar(first.getTime(), '1.5'),
        // Two refused bars on one needed day.
        bar(first.getTime() + DAY, '0'),
        bar(first.getTime() + DAY + 12 * 60 * 60 * 1000, '-1'),
        // A refused bar nine days on, outside the days asked.
        bar(first.getTime() + 9 * DAY, '0'),
      ],
    });

    const result = await service.backfillTokenRange(currency.id, base.id, days);

    expect(result).toMatchObject({
      inserted: 1,
      droppedDays: 1,
      droppedBars: 3,
      providerMissing: 2,
      alreadyHad: 0,
    });
    expect(result.inserted + result.alreadyHad + result.providerMissing + result.droppedDays).toBe(
      days.length
    );
  });

  // Foundation A3, Task 10. The backfill fills empty days. A day that holds a
  // row of any kind keeps it as it is, whatever the provider answers for it.
  describe('a day that already holds a row', () => {
    const first = new Date('2026-02-02T00:00:00.000Z');
    const [before, covered, after] = [0, 1, 2].map((k) => new Date(first.getTime() + k * DAY)) as [
      Date,
      Date,
      Date,
    ];

    /** A provider with a bar at each of the three midnights, asked for the two around `covered`. */
    async function runSpanning(stored: { timestamp: Date; granularity: 'daily' | 'intraday' }) {
      const currency = await commitFiat();
      const base = await commitFiat();
      await getDb()
        .insert(schema.tokenPrices)
        .values({
          tokenId: currency.id,
          baseTokenId: base.id,
          price: '1.25',
          source: 'stored-before',
          ...stored,
        });
      const service = backfill({
        range: (token) =>
          [before, covered, after].map((day) => ({
            tokenId: token.id,
            baseTokenId: base.id,
            price: '1.75',
            timestamp: day,
            source: 'test-fx_historical',
          })),
      });

      const result = await service.backfillTokenRange(currency.id, base.id, [before, after]);

      expect(result).toMatchObject({ inserted: 2, providerMissing: 0 });
      return (await storedFor(currency.id)).map((r) => [
        r.timestamp.toISOString(),
        r.price,
        r.source,
        r.granularity,
      ]);
    }

    test('CONTROL: a stored row on a covered day keeps its price and its source after a run that spans it', async () => {
      // The provider's bar has the stored row's own key, so an upsert replaces it.
      const stored = await runSpanning({ timestamp: covered, granularity: 'daily' });

      expect(stored).toEqual([
        [before.toISOString(), '1.75', 'test-fx_historical', 'daily'],
        [covered.toISOString(), '1.25', 'stored-before', 'daily'],
        [after.toISOString(), '1.75', 'test-fx_historical', 'daily'],
      ]);
    });

    test('a quote on a day that already holds a row is not written', async () => {
      // The provider's bar has a key of its own, so an upsert adds it beside the row.
      const afternoon = new Date(covered.getTime() + 14 * 60 * 60 * 1000);
      const stored = await runSpanning({ timestamp: afternoon, granularity: 'intraday' });

      expect(stored).toEqual([
        [before.toISOString(), '1.75', 'test-fx_historical', 'daily'],
        [afternoon.toISOString(), '1.25', 'stored-before', 'intraday'],
        [after.toISOString(), '1.75', 'test-fx_historical', 'daily'],
      ]);
    });
  });

  // DeFiLlama stamps a daily point at the price's own time, which for a
  // midnight asked is often the last hour of the day before.
  test('the point stamped before the first day asked is written when that day holds no row', async () => {
    const currency = await commitFiat();
    const base = await commitFiat();
    const first = new Date('2026-02-02T00:00:00.000Z');
    const days = [first, new Date(first.getTime() + DAY)];
    const anHourBefore = (day: Date) => new Date(day.getTime() - 60 * 60 * 1000);
    const service = backfill({
      range: (token) =>
        days.map((day) => ({
          tokenId: token.id,
          baseTokenId: base.id,
          price: '1.75',
          timestamp: anHourBefore(day),
          source: 'test-fx_historical',
        })),
    });

    await service.backfillTokenRange(currency.id, base.id, days);

    expect((await storedFor(currency.id)).map((r) => r.timestamp.toISOString())).toEqual(
      days.map((day) => anHourBefore(day).toISOString())
    );
  });
});
