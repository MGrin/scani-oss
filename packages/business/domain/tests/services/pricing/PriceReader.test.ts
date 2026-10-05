import { describe, expect, spyOn, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, eq, isNull, type SQL, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { priceAt } from '../../../src/engine/price-at';
import { indexPriceEvidence } from '../../../src/engine/price-index';
import type {
  AssetClass,
  PriceAsk,
  PriceAt,
  PriceEvidence,
  PriceGranularity,
  PriceReading,
} from '../../../src/engine/types';
import { EngineEvidenceRepository } from '../../../src/repositories/EngineEvidenceRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { PriceHubResolver } from '../../../src/services/pricing/PriceHubResolver';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { withTestDb } from '../../../test/helpers/db';
import { makeToken } from '../../../test/helpers/factories-extra';
import { liftPriceCheck } from '../../../test/helpers/price-check';

const reader = () => Container.get(PriceReader);
const evidence = () => Container.get(EngineEvidenceRepository);

const HOUR_MS = 3_600_000;
const NOW = new Date('2026-03-10T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS);
/** The last millisecond of a UTC day of January 2026. */
const closeOf = (day: number) => new Date(Date.UTC(2026, 0, day, 23, 59, 59, 999));
const noonOf = (day: number) => new Date(Date.UTC(2026, 0, day, 12));
const JAN_1 = new Date(Date.UTC(2026, 0, 1));

async function catalogueId(
  tx: DatabaseTransaction,
  symbol: string,
  typeCode: string
): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .innerJoin(schema.tokenTypes, eq(schema.tokenTypes.id, schema.tokens.typeId))
    .where(
      and(
        eq(schema.tokens.symbol, symbol),
        eq(schema.tokenTypes.code, typeCode),
        isNull(schema.tokens.marketSegment)
      )
    );
  return row?.id;
}

/**
 * The three hubs, and two fiat currencies that are not hubs. USD, EUR, CHF and
 * GBP are seeded by migration; USDT is added where the database has no
 * canonical row.
 */
async function currencies(tx: DatabaseTransaction) {
  if ((await catalogueId(tx, 'USDT', 'crypto')) === undefined) {
    await makeToken(tx, { symbol: 'USDT', name: 'Tether' });
  }
  const [usd, usdt, eur] = await Container.get(PriceHubResolver).hubTokenIds(tx);
  const chf = await catalogueId(tx, 'CHF', 'fiat');
  const gbp = await catalogueId(tx, 'GBP', 'fiat');
  if (!usd || !usdt || !eur || !chf || !gbp) throw new Error('a seeded currency did not resolve');
  return { usd, usdt, eur, chf, gbp };
}

/** A token only its owner prices: the `custom` class, whose own price is never stale. */
async function customToken(tx: DatabaseTransaction) {
  const [type] = await tx
    .select({ id: schema.tokenTypes.id })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, 'private-company'));
  if (!type) throw new Error('the private-company token type is not seeded');
  return makeToken(tx, { typeId: type.id });
}

interface PriceRow {
  tokenId: string;
  baseTokenId: string;
  timestamp: Date;
  price: string;
  granularity?: PriceGranularity;
  source?: string;
}

async function addPrices(tx: DatabaseTransaction, rows: readonly PriceRow[]): Promise<void> {
  await tx
    .insert(schema.tokenPrices)
    .values(rows.map((row) => ({ granularity: 'intraday', ...row })));
}

/** `count` intraday rows on one pair, five minutes apart from `from`, priced 100 to 149 in turn. */
async function addIntradayRows(
  tx: DatabaseTransaction,
  tokenId: string,
  baseTokenId: string,
  from: Date,
  count: number
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO token_prices (token_id, base_token_id, price, timestamp, granularity, source)
    SELECT ${tokenId}::uuid, ${baseTokenId}::uuid, (100 + n % 50)::text,
           ${from.toISOString()}::timestamptz + n * interval '5 minutes', 'intraday', 'fixture'
      FROM generate_series(0, ${count - 1}::int) AS n`);
}

/**
 * Plans over the fixture as it stands. Otherwise the planner goes by whatever
 * autovacuum last saw of the table, which in a test database holds only rolled
 * back rows, and over that the readings statement once read 133,920 rows of a
 * pair, every one at or before each of 30 instants. The bound would measure
 * the statistics rather than the statement.
 */
async function analysePrices(tx: DatabaseTransaction): Promise<void> {
  await tx.execute(sql`ANALYZE token_prices`);
}

/** Every row of one pair, as the readings a loader of its whole history would hand the engine. */
async function wholePair(
  tx: DatabaseTransaction,
  tokenId: string,
  baseTokenId: string
): Promise<PriceReading[]> {
  const rows = await tx
    .select()
    .from(schema.tokenPrices)
    .where(
      and(eq(schema.tokenPrices.tokenId, tokenId), eq(schema.tokenPrices.baseTokenId, baseTokenId))
    );
  return rows.map((row) => ({
    tokenId: row.tokenId,
    baseTokenId: row.baseTokenId,
    price: row.price,
    at: row.timestamp,
    granularity: row.granularity as PriceGranularity,
    source: row.source,
  }));
}

/** The statements `run` sends through `execute`, as they were sent. */
async function statementsOf<T>(
  tx: DatabaseTransaction,
  run: () => Promise<T>
): Promise<{ result: T; statements: SQL[] }> {
  const execute = spyOn(tx, 'execute');
  try {
    const result = await run();
    return { result, statements: execute.mock.calls.map(([statement]) => statement as SQL) };
  } finally {
    execute.mockRestore();
  }
}

/**
 * Rows of `token_prices` this transaction has read so far, by an index or in
 * sequence. A count the server keeps, so it holds whatever plan was chosen.
 */
async function priceRowsRead(tx: DatabaseTransaction): Promise<number> {
  const [row] = (await tx.execute(sql`
    SELECT (seq_tup_read + idx_tup_fetch)::int AS read
      FROM pg_stat_xact_user_tables
     WHERE schemaname = 'public' AND relname = 'token_prices'`)) as unknown as Array<{
    read: number;
  }>;
  if (!row) throw new Error('token_prices has no statistics in this transaction');
  return row.read;
}

interface Plan {
  'Shared Hit Blocks': number;
  'Shared Read Blocks': number;
}

/**
 * The pages running `statement` touched. An index entry a scan steps over
 * without returning it is counted by nothing else the server reports.
 */
async function pagesTouched(tx: DatabaseTransaction, statement: SQL): Promise<number> {
  const [row] = (await tx.execute(
    sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`
  )) as unknown as Array<{ 'QUERY PLAN': Array<{ Plan: Plan }> | string }>;
  const explained = row?.['QUERY PLAN'];
  const [top] = typeof explained === 'string' ? JSON.parse(explained) : (explained ?? []);
  if (!top) throw new Error('EXPLAIN returned no plan');
  return top.Plan['Shared Hit Blocks'] + top.Plan['Shared Read Blocks'];
}

describe('PriceReader.at', () => {
  test('at() prices a token quoted only in a non-hub fiat', async () => {
    await withTestDb(async (tx) => {
      const { usd, chf } = await currencies(tx);
      const x = await customToken(tx);
      await addPrices(tx, [
        { tokenId: x.id, baseTokenId: chf, timestamp: hoursAgo(2), price: '100', source: 'manual' },
        { tokenId: chf, baseTokenId: usd, timestamp: hoursAgo(1), price: '1.1' },
      ]);

      const answer = (await reader().at([x.id], usd, NOW, tx)).get(x.id);

      expect(answer?.price.toString()).toBe('110');
      expect(answer).toMatchObject({
        path: `quote:${chf}`,
        source: 'manual',
        readingAt: hoursAgo(2),
        stale: false,
      });
    });
  });

  test('at() answers as priceAt over every row of the fixture does', async () => {
    await withTestDb(async (tx) => {
      const { usd, usdt, eur } = await currencies(tx);
      const AS_OF = new Date('2026-03-01T00:30:00Z');
      const MAR_1 = new Date('2026-03-01T00:00:00Z');
      const FEB_28 = new Date('2026-02-28T00:00:00Z');
      const FEB_1 = new Date('2026-02-01T00:00:00Z');
      // The SC-1477 shape: an old row in the base, a newer one through the USD hub.
      const throughHub = await makeToken(tx);
      // Quoted in a third currency that has no rate, and in USD a day earlier.
      const thirdQuoted = await makeToken(tx);
      const third = await makeToken(tx);
      const direct = await makeToken(tx);
      const unpriced = await makeToken(tx);
      const rows: PriceRow[] = [
        { tokenId: throughHub.id, baseTokenId: eur, timestamp: FEB_1, price: '9' },
        { tokenId: throughHub.id, baseTokenId: usd, timestamp: MAR_1, price: '10' },
        { tokenId: eur, baseTokenId: usd, timestamp: FEB_28, price: '1.25' },
        { tokenId: eur, baseTokenId: usd, timestamp: MAR_1, price: '1.25' },
        { tokenId: thirdQuoted.id, baseTokenId: usd, timestamp: FEB_28, price: '10' },
        { tokenId: thirdQuoted.id, baseTokenId: third.id, timestamp: MAR_1, price: '1000' },
        { tokenId: direct.id, baseTokenId: eur, timestamp: MAR_1, price: '9', source: 'kraken' },
      ];
      await addPrices(tx, rows);
      const tokenIds = [throughHub.id, thirdQuoted.id, direct.id, unpriced.id, eur];

      // The engine over the rows as written, history and all, with what the
      // reader looks up stated here instead: no loader stands between this
      // expectation and the rows.
      const whole: PriceEvidence = {
        readings: rows.map((row) => ({
          tokenId: row.tokenId,
          baseTokenId: row.baseTokenId,
          price: row.price,
          at: row.timestamp,
          granularity: row.granularity ?? 'intraday',
          source: row.source ?? null,
        })),
        hubTokenIds: [usd, usdt, eur],
        quoteTokenIds: new Map([[thirdQuoted.id, [third.id]]]),
        assetClasses: new Map<string, AssetClass>([
          [usd, 'fiat'],
          [usdt, 'crypto'],
          [eur, 'fiat'],
          [third.id, 'crypto'],
        ]),
      };
      const answers = await reader().at(tokenIds, eur, AS_OF, tx);

      for (const tokenId of tokenIds) {
        const assetClass: AssetClass = tokenId === eur ? 'fiat' : 'crypto';
        const expected = priceAt(whole, { tokenId, assetClass }, eur, AS_OF);
        expect(answers.get(tokenId)).toEqual(expected);
      }
      // What they agree on is the answer, not two absences.
      expect(answers.get(throughHub.id)?.price.toString()).toBe('8');
      expect(answers.get(throughHub.id)).toMatchObject({
        path: `hub:${usd}`,
        readingAt: MAR_1,
        source: null,
        stale: false,
      });
      expect(answers.get(thirdQuoted.id)).toMatchObject({ path: `hub:${usd}`, readingAt: FEB_28 });
      expect(answers.get(direct.id)).toMatchObject({ path: 'direct', source: 'kraken' });
      expect(answers.get(unpriced.id)).toBeNull();
      expect(answers.get(eur)?.path).toBe('identity');
    });
  });

  test('an unpriced token is null, not missing', async () => {
    await withTestDb(async (tx) => {
      const { usd } = await currencies(tx);
      const priced = await makeToken(tx);
      const unpriced = await makeToken(tx);
      await addPrices(tx, [
        { tokenId: priced.id, baseTokenId: usd, timestamp: hoursAgo(1), price: '10' },
      ]);

      const answers = await reader().at([priced.id, unpriced.id, priced.id], usd, NOW, tx);

      expect([...answers.keys()].sort()).toEqual([priced.id, unpriced.id].sort());
      expect(answers.get(unpriced.id)).toBeNull();
      expect(answers.get(priced.id)?.price.toString()).toBe('10');
    });
  });

  test('nothing asked reads nothing', async () => {
    await withTestDb(async (tx) => {
      const { usd } = await currencies(tx);
      const reads = [
        spyOn(Container.get(PriceHubResolver), 'hubTokenIds'),
        spyOn(evidence(), 'findQuoteTokenIds'),
        spyOn(Container.get(TokenRepository), 'findManyWithTypes'),
        spyOn(evidence(), 'findPriceReadingsAtInstants'),
      ];

      let answers: ReadonlyMap<string, PriceAt | null>;
      let calls: number[];
      try {
        answers = await reader().at([], usd, NOW, tx);
        calls = reads.map((read) => read.mock.calls.length);
      } finally {
        for (const read of reads) read.mockRestore();
      }

      expect(answers.size).toBe(0);
      expect(calls).toEqual([0, 0, 0, 0]);
    });
  });

  test('the evidence carries a class for every hub and quote token it loaded', async () => {
    await withTestDb(async (tx) => {
      const { usd, usdt, eur, chf, gbp } = await currencies(tx);
      const x = await customToken(tx);
      // X in CHF, CHF in EUR, EUR in GBP: a quote currency and a hub, each
      // with a leg 60 hours old. Either one read as `unknown` is stale at 48.
      await addPrices(tx, [
        { tokenId: x.id, baseTokenId: chf, timestamp: hoursAgo(1), price: '100', source: 'manual' },
        { tokenId: chf, baseTokenId: eur, timestamp: hoursAgo(60), price: '1.05' },
        { tokenId: eur, baseTokenId: gbp, timestamp: hoursAgo(60), price: '0.8' },
      ]);
      const typed = spyOn(Container.get(TokenRepository), 'findManyWithTypes');

      let answer: PriceAt | null | undefined;
      let later: PriceAt | null | undefined;
      let asked: string[][];
      try {
        answer = (await reader().at([x.id], gbp, NOW, tx)).get(x.id);
        asked = typed.mock.calls.map(([ids]) => [...ids].sort());
        later = (await reader().at([x.id], gbp, new Date(NOW.getTime() + 70 * HOUR_MS), tx)).get(
          x.id
        );
      } finally {
        typed.mockRestore();
      }

      expect(asked).toEqual([[x.id, usd, usdt, eur, chf].sort()]);
      expect(answer?.price.toString()).toBe('84');
      expect(answer).toMatchObject({ path: `quote:${chf}:${eur}`, stale: false });
      // The legs are judged: 130 hours is past the fiat horizon.
      expect(later).toMatchObject({ path: `quote:${chf}:${eur}`, stale: true });
    });
  });

  test('a fiat asset through a 60-hour-old fiat hub rate is not stale', async () => {
    await withTestDb(async (tx) => {
      const { usd, chf, gbp } = await currencies(tx);
      // USD priced in CHF, not CHF in USD: the hub is no currency CHF is quoted
      // in, so its class reaches the engine only as a hub's.
      await addPrices(tx, [
        { tokenId: usd, baseTokenId: chf, timestamp: hoursAgo(1), price: '0.5' },
        { tokenId: usd, baseTokenId: gbp, timestamp: hoursAgo(60), price: '0.8' },
      ]);

      const answer = (await reader().at([chf], gbp, NOW, tx)).get(chf);
      const later = (await reader().at([chf], gbp, new Date(NOW.getTime() + 70 * HOUR_MS), tx)).get(
        chf
      );

      expect(answer?.price.toString()).toBe('1.6');
      expect(answer).toMatchObject({ path: `hub:${usd}`, readingAt: hoursAgo(60), stale: false });
      expect(later?.stale).toBe(true);
    });
  });

  test('a zero row nearer than a positive one does not hide it', async () => {
    await withTestDb(async (tx) => {
      await liftPriceCheck(tx);
      const { usd } = await currencies(tx);
      const x = await makeToken(tx);
      await addPrices(tx, [
        { tokenId: x.id, baseTokenId: usd, timestamp: hoursAgo(5), price: '10' },
        { tokenId: x.id, baseTokenId: usd, timestamp: hoursAgo(3), price: '0' },
        { tokenId: x.id, baseTokenId: usd, timestamp: hoursAgo(2), price: '-5' },
      ]);

      const answer = (await reader().at([x.id], usd, NOW, tx)).get(x.id);

      expect(answer?.price.toString()).toBe('10');
      expect(answer?.readingAt).toEqual(hoursAgo(5));
    });
  });
});

describe('PriceReader.series', () => {
  test('series() answers every asked day as at() does for that day', async () => {
    await withTestDb(async (tx) => {
      const { usd, eur, chf } = await currencies(tx);
      const days = Array.from({ length: 30 }, (_, index) => index + 1);
      const inBase = await makeToken(tx);
      const inEur = await makeToken(tx);
      const inChf = await customToken(tx);
      await addPrices(tx, [
        // Daily closes, none on a seventh day; those have a noon reading.
        ...days.map((day) =>
          day % 7 === 0
            ? {
                tokenId: inBase.id,
                baseTokenId: usd,
                timestamp: noonOf(day),
                price: `${200 + day}`,
              }
            : {
                tokenId: inBase.id,
                baseTokenId: usd,
                timestamp: closeOf(day),
                price: `${100 + day}`,
                granularity: 'daily' as const,
              }
        ),
        ...days.map((day) => ({
          tokenId: inEur.id,
          baseTokenId: eur,
          timestamp: closeOf(day),
          price: `${50 + day}`,
          granularity: 'daily' as const,
        })),
        ...days
          .filter((day) => day % 3 === 0)
          .map((day) => ({
            tokenId: eur,
            baseTokenId: usd,
            timestamp: closeOf(day),
            price: day % 2 === 0 ? '1.2' : '1.1',
            granularity: 'daily' as const,
          })),
        {
          tokenId: inChf.id,
          baseTokenId: chf,
          timestamp: noonOf(5),
          price: '1000',
          source: 'manual',
        },
        {
          tokenId: inChf.id,
          baseTokenId: chf,
          timestamp: noonOf(20),
          price: '2000',
          source: 'manual',
        },
        ...days.map((day) => ({
          tokenId: chf,
          baseTokenId: usd,
          timestamp: closeOf(day),
          price: '1.1',
          granularity: 'daily' as const,
        })),
      ]);
      const tokenIds = [inBase.id, inEur.id, inChf.id];
      const asks: PriceAsk[] = days.flatMap((day) =>
        tokenIds.map((tokenId) => ({ tokenId, at: closeOf(day) }))
      );
      const quotes = spyOn(evidence(), 'findQuoteTokenIds');
      const types = spyOn(Container.get(TokenRepository), 'findManyWithTypes');
      const loads = spyOn(evidence(), 'findPriceReadingsAtInstants');

      let statements: number[];
      let series: Awaited<ReturnType<PriceReader['series']>>;
      try {
        series = await reader().series(asks, usd, tx);
        statements = [quotes, types, loads].map((spy) => spy.mock.calls.length);
      } finally {
        quotes.mockRestore();
        types.mockRestore();
        loads.mockRestore();
      }

      // Three tokens on thirty days: one statement each for quotes, types and readings.
      expect(statements).toEqual([1, 1, 1]);
      const paths = new Set<string>();
      for (const day of days) {
        const that = await reader().at(tokenIds, usd, closeOf(day), tx);
        for (const tokenId of tokenIds) {
          const answer = series.priceAt(tokenId, closeOf(day));
          expect(answer).toEqual(that.get(tokenId) ?? null);
          paths.add(answer?.path ?? 'unpriced');
        }
      }
      expect([...paths].sort()).toEqual(
        ['direct', `hub:${eur}`, `quote:${chf}`, 'unpriced'].sort()
      );
      expect(series.priceAt(inBase.id, closeOf(7))?.price.toString()).toBe('207');
      expect(series.priceAt(inBase.id, closeOf(8))?.price.toString()).toBe('108');
      expect(series.priceAt(inChf.id, closeOf(20))?.price.toString()).toBe('2200');
    });
  });

  test('an instant that was not asked throws', async () => {
    await withTestDb(async (tx) => {
      const { usd } = await currencies(tx);
      const x = await makeToken(tx);
      const y = await makeToken(tx);
      await addPrices(tx, [
        { tokenId: x.id, baseTokenId: usd, timestamp: hoursAgo(2), price: '10' },
        { tokenId: y.id, baseTokenId: usd, timestamp: hoursAgo(2), price: '20' },
      ]);

      const series = await reader().series([{ tokenId: x.id, at: NOW }], usd, tx);

      expect(() => series.priceAt(x.id, hoursAgo(1))).toThrow(RangeError);
      expect(() => series.priceAt(y.id, NOW)).toThrow(RangeError);
      expect(series.priceAt(x.id, NOW)?.price.toString()).toBe('10');
    });
  });

  test('the fingerprint is the same whatever order the readings load in, and moves with a reading', async () => {
    await withTestDb(async (tx) => {
      const { usd } = await currencies(tx);
      const x = await makeToken(tx);
      await addPrices(tx, [
        { tokenId: x.id, baseTokenId: usd, timestamp: closeOf(1), price: '10' },
        { tokenId: x.id, baseTokenId: usd, timestamp: closeOf(2), price: '11' },
        { tokenId: x.id, baseTokenId: usd, timestamp: closeOf(3), price: '12' },
      ]);
      const asks = [1, 2, 3].map((day) => ({ tokenId: x.id, at: closeOf(day) }));
      const load = evidence().findPriceReadingsAtInstants.bind(evidence());

      const first = await reader().series(asks, usd, tx);
      const reversed = spyOn(evidence(), 'findPriceReadingsAtInstants').mockImplementation(
        async (pairAsks, transaction) => (await load(pairAsks, transaction)).reverse()
      );
      let backwards: string;
      try {
        backwards = (await reader().series(asks, usd, tx)).fingerprint;
      } finally {
        reversed.mockRestore();
      }
      await tx
        .update(schema.tokenPrices)
        .set({ price: '13' })
        .where(
          and(eq(schema.tokenPrices.tokenId, x.id), eq(schema.tokenPrices.timestamp, closeOf(2)))
        );
      const corrected = await reader().series(asks, usd, tx);

      expect(first.fingerprint).toMatch(/^[0-9a-f]{32}$/);
      expect(backwards).toBe(first.fingerprint);
      expect(corrected.fingerprint).not.toBe(first.fingerprint);
    });
  });
});

describe('the load is bounded', () => {
  test('10,000 intraday rows on a pair: a 30-instant series reads at most 60 rows of it', async () => {
    await withTestDb(async (tx) => {
      const { usd } = await currencies(tx);
      const hubTokenIds = await Container.get(PriceHubResolver).hubTokenIds(tx);
      const x = await makeToken(tx);
      await addIntradayRows(tx, x.id, usd, JAN_1, 10_000);
      await analysePrices(tx);
      const instants = Array.from({ length: 30 }, (_, index) => closeOf(index + 1));
      const loads = spyOn(evidence(), 'findPriceReadingsAtInstants');

      let series: Awaited<ReturnType<PriceReader['series']>>;
      let asked: Parameters<EngineEvidenceRepository['findPriceReadingsAtInstants']>[0];
      let loaded: PriceReading[];
      try {
        series = await reader().series(
          instants.map((at) => ({ tokenId: x.id, at })),
          usd,
          tx
        );
        expect(loads).toHaveBeenCalledTimes(1);
        asked = loads.mock.calls[0]?.[0] ?? [];
        loaded =
          (await (loads.mock.results[0]?.value as Promise<PriceReading[]> | undefined)) ?? [];
      } finally {
        loads.mockRestore();
      }

      // What the statement returns of the pair, and what it reads to return it.
      const ofThePair = loaded.filter((r) => r.tokenId === x.id && r.baseTokenId === usd);
      expect(ofThePair).toHaveLength(30);
      const before = await priceRowsRead(tx);
      await evidence().findPriceReadingsAtInstants(asked, tx);
      const read = (await priceRowsRead(tx)) - before;
      // CONTROL: it returned 30 rows, so a count that sees nothing cannot pass.
      expect(read).toBeGreaterThanOrEqual(30);
      expect(read).toBeLessThanOrEqual(60);

      // CONTROL: the same answers as a load of the whole pair.
      const whole = indexPriceEvidence({ readings: await wholePair(tx, x.id, usd), hubTokenIds });
      const asset = { tokenId: x.id, assetClass: 'crypto' as const };
      for (const at of instants) {
        expect(series.priceAt(x.id, at)).toEqual(priceAt(whole, asset, usd, at));
      }
      expect(series.priceAt(x.id, closeOf(1))?.readingAt).toEqual(
        new Date(Date.UTC(2026, 0, 1, 23, 55))
      );
    });
  });

  test('10,000 intraday rows on a pair, all after `until`: the quotes statement reads a bounded number of pages', async () => {
    await withTestDb(async (tx) => {
      const x = await makeToken(tx);
      // The base with the history sorts first, so a step that filtered by time
      // would walk all of it on the way to the other.
      const [later, earlier] = [await makeToken(tx), await makeToken(tx)].sort((a, b) =>
        a.id < b.id ? -1 : 1
      );
      if (!later || !earlier) throw new Error('two tokens were not made');
      const until = closeOf(1);
      await addIntradayRows(tx, x.id, later.id, new Date(Date.UTC(2026, 0, 2)), 10_000);
      await addPrices(tx, [
        { tokenId: x.id, baseTokenId: earlier.id, timestamp: noonOf(1), price: '10' },
      ]);
      // Analysed, as the readings test is. Over statistics that count no live row
      // in the table's pages, this statement touched 115 pages run alone and 119
      // in the whole file: the bound measured the statistics, not the statement.
      await analysePrices(tx);

      const { result, statements } = await statementsOf(tx, () =>
        evidence().findQuoteTokenIds([x.id], until, tx)
      );

      expect(result).toEqual(new Map([[x.id, [earlier.id]]]));
      expect(statements).toHaveLength(1);
      // Measured, analysed: 13 to 18 pages stepping the index, alone and in the
      // whole file, after fresh statistics or ones that counted no live row. A
      // DISTINCT over the token touches 3 to 5 pages here on fresh statistics,
      // so the next test, whose history is at or before `until`, catches it.
      const pages = await pagesTouched(tx, statements[0] as SQL);
      // CONTROL: the statement touches the index at all, so a count of nothing fails.
      expect(pages).toBeGreaterThan(0);
      expect(pages).toBeLessThanOrEqual(30);
    });
  });

  test('10,000 intraday rows on a pair, all at or before `until`: the quotes statement still reads a bounded number of pages', async () => {
    await withTestDb(async (tx) => {
      const x = await makeToken(tx);
      const [withHistory, withOne] = [await makeToken(tx), await makeToken(tx)].sort((a, b) =>
        a.id < b.id ? -1 : 1
      );
      if (!withHistory || !withOne) throw new Error('two tokens were not made');
      await addIntradayRows(tx, x.id, withHistory.id, JAN_1, 10_000);
      await addPrices(tx, [
        { tokenId: x.id, baseTokenId: withOne.id, timestamp: noonOf(1), price: '10' },
      ]);
      // Analysed, as the readings test is. Over statistics that count no live row
      // in the table's pages, this statement touched 523 pages run alone and
      // 29,957 in the whole file; analysed, 14, and a DISTINCT still 154.
      await analysePrices(tx);
      // Five minutes after the last row. Every row of X is at or before it, so a
      // DISTINCT over the token reads all of them whatever the planner knows.
      const until = new Date(JAN_1.getTime() + 10_000 * 5 * 60_000);

      const { result, statements } = await statementsOf(tx, () =>
        evidence().findQuoteTokenIds([x.id], until, tx)
      );

      expect([...(result.get(x.id) ?? [])].sort()).toEqual([withHistory.id, withOne.id].sort());
      expect(statements).toHaveLength(1);
      const pages = await pagesTouched(tx, statements[0] as SQL);
      expect(pages).toBeGreaterThan(0);
      expect(pages).toBeLessThanOrEqual(30);
    });
  });
});
