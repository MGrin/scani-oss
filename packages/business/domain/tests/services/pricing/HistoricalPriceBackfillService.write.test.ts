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
import { type PriceWriteOutcome, PriceWriter } from '../../../src/services/pricing/PriceWriter';
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
  test('a range lands as daily rows at each bar’s close, under its source, against the base asked', async () => {
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
          barDay: day.toISOString().slice(0, 10),
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
        day.getTime() + DAY - 1,
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
          barDay: null,
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
      barDay: null,
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

  // Foundation A3, Tasks 10 and 13. The backfill fills days that are not
  // covered. A covered day keeps what it holds, whatever the provider answers.
  describe('a day that already holds a row', () => {
    const first = new Date('2026-02-02T00:00:00.000Z');
    const februaryDays = [0, 1, 2].map((k) => new Date(first.getTime() + k * DAY)) as [
      Date,
      Date,
      Date,
    ];
    const close = (day: Date) => new Date(day.getTime() + DAY - 1);

    /** A provider with each day's close, asked for the two days around `covered`. */
    async function runSpanning(
      [before, covered, after]: [Date, Date, Date],
      stored: { timestamp: Date; granularity: 'daily' | 'intraday' }
    ) {
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
            barDay: day.toISOString().slice(0, 10),
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
      const [before, covered, after] = februaryDays;
      // The provider's close has the stored row's own key.
      const stored = await runSpanning(februaryDays, {
        timestamp: close(covered),
        granularity: 'daily',
      });

      expect(stored).toEqual([
        [close(before).toISOString(), '1.75', 'test-fx_historical', 'daily'],
        [close(covered).toISOString(), '1.25', 'stored-before', 'daily'],
        [close(after).toISOString(), '1.75', 'test-fx_historical', 'daily'],
      ]);
    });

    test('a 14:00 row more than 7 days old still covers its day', async () => {
      const [before, covered, after] = februaryDays;
      const afternoon = new Date(covered.getTime() + 14 * 60 * 60 * 1000);
      const stored = await runSpanning(februaryDays, {
        timestamp: afternoon,
        granularity: 'intraday',
      });

      expect(stored).toEqual([
        [close(before).toISOString(), '1.75', 'test-fx_historical', 'daily'],
        [afternoon.toISOString(), '1.25', 'stored-before', 'intraday'],
        [close(after).toISOString(), '1.75', 'test-fx_historical', 'daily'],
      ]);
    });

    test('a 14:00 row two days old does not cover its day', async () => {
      const now = new Date();
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const recentDays = [3, 2, 1].map((k) => new Date(today - k * DAY)) as [Date, Date, Date];
      const [before, covered, after] = recentDays;
      const afternoon = new Date(covered.getTime() + 14 * 60 * 60 * 1000);
      const stored = await runSpanning(recentDays, {
        timestamp: afternoon,
        granularity: 'intraday',
      });

      expect(stored).toEqual([
        [close(before).toISOString(), '1.75', 'test-fx_historical', 'daily'],
        [afternoon.toISOString(), '1.25', 'stored-before', 'intraday'],
        [close(covered).toISOString(), '1.75', 'test-fx_historical', 'daily'],
        [close(after).toISOString(), '1.75', 'test-fx_historical', 'daily'],
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
          barDay: null,
          source: 'test-fx_historical',
        })),
    });

    await service.backfillTokenRange(currency.id, base.id, days);

    expect((await storedFor(currency.id)).map((r) => r.timestamp.toISOString())).toEqual(
      days.map((day) => anHourBefore(day).toISOString())
    );
  });
});

/** Foundation A3, Task 13: a bar is stored as the close of the UTC day it names. */
describe('the close of each UTC day', () => {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayKey = todayStart.toISOString().slice(0, 10);

  async function currencyAndBase() {
    return { currency: await commitFiat(), base: await commitFiat() };
  }

  function bar(
    pair: { currency: Token; base: Token },
    price: string,
    timestamp: Date,
    barDay: string | null,
    extra: Partial<PriceQuote> = {}
  ): PriceQuote {
    return {
      tokenId: pair.currency.id,
      baseTokenId: pair.base.id,
      price,
      timestamp,
      barDay,
      source: 'test-fx_historical',
      ...extra,
    };
  }

  async function storedRows(tokenId: string) {
    return (await storedFor(tokenId)).map((r) => [
      r.timestamp.toISOString(),
      r.price,
      r.granularity,
    ]);
  }

  test('a daily bar is stored at its day’s last millisecond', async () => {
    const pair = await currencyAndBase();
    // The close of 20 September, stamped at the midnight that ends it.
    const service = backfill({
      range: () => [bar(pair, '2', new Date('2026-09-21T00:00:00.000Z'), '2026-09-20')],
    });

    const result = await service.backfillTokenRange(pair.currency.id, pair.base.id, [
      new Date('2026-09-20T00:00:00.000Z'),
    ]);

    expect(await storedRows(pair.currency.id)).toEqual([
      ['2026-09-20T23:59:59.999Z', '2', 'daily'],
    ]);
    expect(result.inserted).toBe(1);
  });

  test('today’s in-progress bar is stored intraday at the fetch instant', async () => {
    const pair = await currencyAndBase();
    let requestEnd: Date | undefined;
    const service = backfill({
      range: (_token, _from, to) => {
        requestEnd = to;
        return [bar(pair, '2', todayStart, todayKey)];
      },
    });
    const start = Date.now();

    const result = await service.backfillTokenRange(pair.currency.id, pair.base.id, [todayStart]);

    const end = Date.now();
    const [row, ...others] = await storedFor(pair.currency.id);
    expect(others).toEqual([]);
    expect(row?.granularity).toBe('intraday');
    expect(row?.timestamp.getTime()).toBeGreaterThanOrEqual(start);
    expect(row?.timestamp.getTime()).toBeLessThanOrEqual(end);
    // One clock read per range: the instant the request ends at is the stamp.
    expect(row?.timestamp).toEqual(requestEnd);
    expect(result.inserted).toBe(1);
  });

  test('a quote with `barDay: null` is stored intraday at its own stamp', async () => {
    const pair = await currencyAndBase();
    const service = backfill({
      range: () => [bar(pair, '2', new Date('2026-09-20T14:00:00.000Z'), null)],
    });

    await service.backfillTokenRange(pair.currency.id, pair.base.id, [
      new Date('2026-09-20T00:00:00.000Z'),
    ]);

    expect(await storedRows(pair.currency.id)).toEqual([
      ['2026-09-20T14:00:00.000Z', '2', 'intraday'],
    ]);
  });

  test('a Tier 2 quote with barDay absent is stored as before, daily at its own stamp', async () => {
    const pair = await currencyAndBase();
    const service = backfill({
      range: () => [
        bar(pair, '2', new Date('2026-09-21T00:00:00.000Z'), null, { legacyDaily: true }),
      ],
    });

    await service.backfillTokenRange(pair.currency.id, pair.base.id, [
      new Date('2026-09-21T00:00:00.000Z'),
    ]);

    expect(await storedRows(pair.currency.id)).toEqual([
      ['2026-09-21T00:00:00.000Z', '2', 'daily'],
    ]);
  });

  test('the request for a needed day reaches that day’s close', async () => {
    const pair = await currencyAndBase();
    let requestEnd: Date | undefined;
    const service = backfill({
      range: (_token, _from, to) => {
        requestEnd = to;
        return [];
      },
    });

    await service.backfillTokenRange(pair.currency.id, pair.base.id, [
      new Date('2026-09-20T00:00:00.000Z'),
    ]);

    expect(requestEnd).toEqual(new Date('2026-09-21T00:00:00.000Z'));
  });

  test('a request that reaches today ends at the fetch instant, not after it', async () => {
    const pair = await currencyAndBase();
    let requestEnd: Date | undefined;
    const service = backfill({
      range: (_token, _from, to) => {
        requestEnd = to;
        return [];
      },
    });
    const start = Date.now();

    await service.backfillTokenRange(pair.currency.id, pair.base.id, [todayStart]);

    const end = Date.now();
    expect(requestEnd?.getTime()).toBeGreaterThanOrEqual(start);
    expect(requestEnd?.getTime()).toBeLessThanOrEqual(end);
  });

  test('the request starts the day before the first needed day', async () => {
    const pair = await currencyAndBase();
    let requestStart: Date | undefined;
    const service = backfill({
      range: (_token, from) => {
        requestStart = from;
        return [];
      },
    });

    await service.backfillTokenRange(pair.currency.id, pair.base.id, [
      new Date('2026-09-22T00:00:00.000Z'),
      new Date('2026-09-20T00:00:00.000Z'),
    ]);

    expect(requestStart).toEqual(new Date('2026-09-19T00:00:00.000Z'));
  });

  test('re-running a range writes nothing new', async () => {
    const pair = await currencyAndBase();
    const writer = Container.get(PriceWriter);
    const outcomes: PriceWriteOutcome[] = [];
    Container.set(PriceWriter, {
      writeHistory: async (...args: Parameters<PriceWriter['writeHistory']>) => {
        const outcome = await writer.writeHistory(...args);
        outcomes.push(outcome);
        return outcome;
      },
    } as unknown as PriceWriter);
    try {
      // A close stamped on the next UTC day, so a run that keyed coverage by
      // the stamp would read the day as empty and send the bar again.
      const service = backfill({
        range: () => [bar(pair, '2', new Date('2026-09-21T00:00:00.000Z'), '2026-09-20')],
      });
      const needed = [new Date('2026-09-20T00:00:00.000Z')];
      await service.backfillTokenRange(pair.currency.id, pair.base.id, needed);
      const afterFirst = await storedFor(pair.currency.id);
      outcomes.length = 0;

      await service.backfillTokenRange(pair.currency.id, pair.base.id, needed);

      expect(outcomes.flatMap((outcome) => outcome.seriesChanged)).toEqual([]);
      expect(outcomes.reduce((sum, outcome) => sum + outcome.written, 0)).toBe(0);
      expect(await storedFor(pair.currency.id)).toEqual(afterFirst);
    } finally {
      Container.set(PriceWriter, writer);
    }
  });

  test('an unstorable later quote does not hide a storable one for the same key', async () => {
    const pair = await currencyAndBase();
    const service = backfill({
      range: () => [
        bar(pair, '0', new Date('2026-09-20T20:00:02.000Z'), '2026-09-20'),
        bar(pair, '10', new Date('2026-09-20T20:00:00.000Z'), '2026-09-20'),
      ],
    });

    const result = await service.backfillTokenRange(pair.currency.id, pair.base.id, [
      new Date('2026-09-20T00:00:00.000Z'),
    ]);

    expect(await storedRows(pair.currency.id)).toEqual([
      ['2026-09-20T23:59:59.999Z', '10', 'daily'],
    ]);
    expect(result).toMatchObject({ inserted: 1, droppedDays: 0, droppedBars: 1 });
  });

  test('two quotes for one key are written as one, the later one', async () => {
    const pair = await currencyAndBase();
    // A session bar and the terminal quote of the same trading date, the
    // later one first.
    const service = backfill({
      range: () => [
        bar(pair, '11', new Date('2026-09-20T20:00:02.000Z'), '2026-09-20'),
        bar(pair, '10', new Date('2026-09-20T20:00:00.000Z'), '2026-09-20'),
      ],
    });

    await service.backfillTokenRange(pair.currency.id, pair.base.id, [
      new Date('2026-09-20T00:00:00.000Z'),
    ]);

    expect(await storedRows(pair.currency.id)).toEqual([
      ['2026-09-20T23:59:59.999Z', '11', 'daily'],
    ]);
  });
});
