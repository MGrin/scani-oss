/**
 * `PriceWriter`, the one writer of `token_prices` (foundation A3, Task 6), and
 * the CHECK that makes the column refuse what the writer drops.
 *
 * Every write here runs inside the test's own transaction, which is rolled
 * back, except the one test that shows a write with no transaction opens and
 * commits its own.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { type DatabaseTransaction, getDb } from '@scani/db';
import type { Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { CANONICAL_PRICE_TEXT, positivePrice } from '../../../src/engine/price-index';
import { type PriceWrite, PriceWriter } from '../../../src/services/pricing/PriceWriter';
import { committedRows, dropPricesOf } from '../../../test/helpers/committed-rows';
import { withTestDb } from '../../../test/helpers/db';
import { makeToken } from '../../../test/helpers/factories-extra';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const MIGRATIONS = new URL('../../../../../infra/db/src/migrations/', import.meta.url).pathname;
const CHECK_MIGRATION = '_token_prices_price_is_a_positive_decimal.sql';

async function pair(tx: DatabaseTransaction): Promise<{ token: Token; base: Token }> {
  return { token: await makeToken(tx), base: await makeToken(tx) };
}

function reading(
  token: Token,
  base: Token,
  price: string,
  at: Date,
  overrides: Partial<PriceWrite> = {}
): PriceWrite {
  return {
    tokenId: token.id,
    baseTokenId: base.id,
    price,
    at,
    granularity: 'intraday',
    source: 'test',
    ...overrides,
  };
}

function storedFor(tx: DatabaseTransaction, tokenIds: string[]) {
  return tx
    .select()
    .from(schema.tokenPrices)
    .where(inArray(schema.tokenPrices.tokenId, tokenIds))
    .orderBy(asc(schema.tokenPrices.timestamp));
}

/**
 * The expression of every CHECK in a migration, comments stripped and
 * whitespace collapsed: a comment may quote the pattern without carrying it.
 */
function checkExpressions(migration: string): string[] {
  const code = migration.replace(/--.*$/gm, '').replace(/\s+/g, ' ');
  const out: string[] = [];
  for (const match of code.matchAll(/\bCHECK\s*\(/gi)) {
    let depth = 1;
    let i = (match.index ?? 0) + match[0].length;
    const start = i;
    for (; i < code.length && depth > 0; i += 1) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')') depth -= 1;
    }
    out.push(code.slice(start, i - 1).trim());
  }
  return out;
}

/** The SQLSTATE a failed statement carries, wherever the driver put it. */
function sqlState(error: unknown): string | undefined {
  const own = (error as { code?: unknown }).code;
  if (typeof own === 'string') return own;
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof cause === 'string' ? cause : undefined;
}

describe('PriceWriter.writeCurrent', () => {
  test('writeCurrent: a first reading is a change', async () => {
    await withTestDb(async (tx) => {
      const { token, base } = await pair(tx);
      const at = new Date('2026-03-01T10:00:00Z');

      const outcome = await new PriceWriter().writeCurrent([reading(token, base, '100', at)], tx);

      expect(outcome).toEqual({
        written: 1,
        dropped: 0,
        changed: [{ tokenId: token.id, baseTokenId: base.id, at }],
        seriesChanged: [],
      });
      const stored = await storedFor(tx, [token.id]);
      expect(stored.map((r) => [r.price, r.timestamp.getTime(), r.granularity, r.source])).toEqual([
        ['100', at.getTime(), 'intraday', 'test'],
      ]);
    });
  });

  test('writeCurrent: the same price an hour later is written and is not a change', async () => {
    await withTestDb(async (tx) => {
      const { token, base } = await pair(tx);
      const writer = new PriceWriter();
      const at = new Date('2026-03-01T10:00:00Z');
      await writer.writeCurrent([reading(token, base, '100.0', at)], tx);

      // '100' reads as the stored '100.0': a change is a different number, not different text.
      const outcome = await writer.writeCurrent(
        [reading(token, base, '100', new Date(at.getTime() + HOUR))],
        tx
      );

      expect(outcome).toEqual({ written: 1, dropped: 0, changed: [], seriesChanged: [] });
      expect(await storedFor(tx, [token.id])).toHaveLength(2);
    });
  });

  test('writeCurrent: a different price is a change at the new instant', async () => {
    await withTestDb(async (tx) => {
      const { token, base } = await pair(tx);
      const writer = new PriceWriter();
      const at = new Date('2026-03-01T10:00:00Z');
      const later = new Date(at.getTime() + HOUR);
      await writer.writeCurrent([reading(token, base, '100', at)], tx);

      const outcome = await writer.writeCurrent([reading(token, base, '101', later)], tx);

      expect(outcome.changed).toEqual([{ tokenId: token.id, baseTokenId: base.id, at: later }]);
    });
  });

  test('writeCurrent: the reading compared is the latest at or before the instant, never after it', async () => {
    await withTestDb(async (tx) => {
      const { token, base } = await pair(tx);
      const writer = new PriceWriter();
      const at = new Date('2026-03-01T10:00:00Z');
      await writer.writeCurrent([reading(token, base, '100', at)], tx);
      await writer.writeCurrent(
        [reading(token, base, '200', new Date(at.getTime() + 2 * HOUR))],
        tx
      );

      // Between the two: compared with 100, so the same price is no change.
      const between = new Date(at.getTime() + HOUR);
      const same = await writer.writeCurrent([reading(token, base, '100', between)], tx);
      // Re-sent at the instant it is stored: compared with itself.
      const again = await writer.writeCurrent([reading(token, base, '100', at)], tx);
      // Repriced in place: the row it replaces had another price.
      const repriced = await writer.writeCurrent([reading(token, base, '150', at)], tx);

      expect(same.changed).toEqual([]);
      expect(again.changed).toEqual([]);
      expect(repriced.changed).toEqual([{ tokenId: token.id, baseTokenId: base.id, at }]);
      const stored = await storedFor(tx, [token.id]);
      expect(stored.map((r) => r.price)).toEqual(['150', '100', '200']);
    });
  });

  test('writeCurrent: two rows for one pair in one call throw', async () => {
    await withTestDb(async (tx) => {
      const { token, base } = await pair(tx);
      const other = await makeToken(tx);
      const at = new Date('2026-03-01T10:00:00Z');

      await expect(
        new PriceWriter().writeCurrent(
          [
            reading(other, base, '7', at),
            reading(token, base, '100', at),
            reading(token, base, '101', new Date(at.getTime() + HOUR)),
          ],
          tx
        )
      ).rejects.toThrow('two readings for one pair in one call');

      // Nothing of the call is written, the other pair's row included.
      expect(await storedFor(tx, [token.id, other.id])).toEqual([]);
    });
  });

  test('writeCurrent: a dropped quote beside a reading of the same pair is not a second row', async () => {
    await withTestDb(async (tx) => {
      const { token, base } = await pair(tx);
      const at = new Date('2026-03-01T10:00:00Z');

      // The router's failure sentinel is a '0' quote; with a fallback's real
      // quote for the same pair it must not fail the batch.
      const outcome = await new PriceWriter().writeCurrent(
        [reading(token, base, '0', at), reading(token, base, '100', at)],
        tx
      );

      expect([outcome.written, outcome.dropped]).toEqual([1, 1]);
      expect((await storedFor(tx, [token.id])).map((r) => r.price)).toEqual(['100']);
    });
  });

  test('with no transaction it opens its own and commits', async () => {
    const rows = committedRows();
    try {
      const { token, base } = await getDb().transaction(async (tx) => pair(tx));
      rows.tokens.push(token.id, base.id);
      const at = new Date('2026-03-01T10:00:00Z');

      const outcome = await new PriceWriter().writeCurrent([reading(token, base, '100', at)]);

      expect(outcome.written).toBe(1);
      const stored = await getDb()
        .select()
        .from(schema.tokenPrices)
        .where(
          and(eq(schema.tokenPrices.tokenId, token.id), eq(schema.tokenPrices.baseTokenId, base.id))
        );
      expect(stored.map((r) => r.price)).toEqual(['100']);
    } finally {
      await dropPricesOf(rows.tokens);
      await rows.drop();
    }
  });
});

describe('PriceWriter.writeHistory', () => {
  test('writeHistory: fromDay is the earliest day inserted or changed, per pair', async () => {
    await withTestDb(async (tx) => {
      const { token, base } = await pair(tx);
      const fresh = await makeToken(tx);
      const writer = new PriceWriter();
      const day = (d: number) => new Date(Date.parse('2026-02-01T00:00:00Z') + d * DAY);
      const bar = (t: Token, price: string, d: number) =>
        reading(t, base, price, day(d), { granularity: 'daily', source: 'test_historical' });
      await writer.writeHistory(
        [bar(token, '10', 1), bar(token, '11', 2), bar(token, '12', 3)],
        tx
      );

      // Out of order on purpose. For `token` day 1 and 3 are re-sent as they
      // are, day 2 is repriced and day 4 is new; `fresh` has nothing stored.
      const outcome = await writer.writeHistory(
        [
          bar(token, '13', 4),
          bar(fresh, '5', 6),
          bar(token, '12', 3),
          bar(token, '11.5', 2),
          bar(fresh, '4', 5),
          bar(token, '10', 1),
        ],
        tx
      );

      expect(outcome.written).toBe(6);
      expect(outcome.changed).toEqual([]);
      expect(outcome.seriesChanged).toEqual([
        { tokenId: token.id, baseTokenId: base.id, fromDay: '2026-02-03' },
        { tokenId: fresh.id, baseTokenId: base.id, fromDay: '2026-02-06' },
      ]);
      const stored = await storedFor(tx, [token.id]);
      expect(stored.map((r) => [r.price, r.granularity])).toEqual([
        ['10', 'daily'],
        ['11.5', 'daily'],
        ['12', 'daily'],
        ['13', 'daily'],
      ]);
    });
  });

  test('writeHistory: re-sending the same bars changes nothing', async () => {
    await withTestDb(async (tx) => {
      const { token, base } = await pair(tx);
      const writer = new PriceWriter();
      const bars = [1, 2, 3].map((d) =>
        reading(token, base, String(10 + d), new Date(Date.parse('2026-02-01') + d * DAY), {
          granularity: 'daily',
        })
      );
      const first = await writer.writeHistory(bars, tx);

      const again = await writer.writeHistory(bars, tx);

      expect(first.seriesChanged).toEqual([
        { tokenId: token.id, baseTokenId: base.id, fromDay: '2026-02-02' },
      ]);
      expect(again).toEqual({ written: 3, dropped: 0, changed: [], seriesChanged: [] });
      expect(await storedFor(tx, [token.id])).toHaveLength(3);
    });
  });

  test('a bar at the instant of an intraday reading is its own row, and a new one', async () => {
    await withTestDb(async (tx) => {
      const { token, base } = await pair(tx);
      const writer = new PriceWriter();
      const at = new Date('2026-02-02T00:00:00Z');
      await writer.writeCurrent([reading(token, base, '10', at)], tx);

      const outcome = await writer.writeHistory(
        [reading(token, base, '10', at, { granularity: 'daily' })],
        tx
      );

      expect(outcome.seriesChanged).toEqual([
        { tokenId: token.id, baseTokenId: base.id, fromDay: '2026-02-02' },
      ]);
      const stored = await storedFor(tx, [token.id]);
      expect(stored.map((r) => r.granularity).sort()).toEqual(['daily', 'intraday']);
    });
  });
});

describe('PriceWriter.writeManual', () => {
  test('a person’s price is inserted inside the caller’s transaction, and goes with it', async () => {
    const rows = committedRows();
    try {
      const { token, base } = await getDb().transaction(async (tx) => pair(tx));
      rows.tokens.push(token.id, base.id);
      const at = new Date('2026-03-01T10:00:00Z');
      const manual = reading(token, base, '2000', at, { source: 'manual' });

      const rolledBack = new Error('rolled back on purpose');
      const outcome = await getDb()
        .transaction(async (tx) => {
          const written = await new PriceWriter().writeManual(manual, tx);
          const inside = await storedFor(tx, [token.id]);
          expect(inside.map((r) => [r.price, r.source, r.granularity])).toEqual([
            ['2000', 'manual', 'intraday'],
          ]);
          return Promise.reject(Object.assign(rolledBack, { written }));
        })
        .catch((error: Error & { written?: unknown }) => {
          if (error !== rolledBack) throw error;
          return error.written;
        });

      expect(outcome).toEqual({
        written: 1,
        dropped: 0,
        changed: [{ tokenId: token.id, baseTokenId: base.id, at }],
        seriesChanged: [],
      });
      const after = await getDb()
        .select()
        .from(schema.tokenPrices)
        .where(eq(schema.tokenPrices.tokenId, token.id));
      expect(after).toEqual([]);
    } finally {
      await dropPricesOf(rows.tokens);
      await rows.drop();
    }
  });

  test('a second manual row at the same instant is refused: it is an insert, not an upsert', async () => {
    await withTestDb(async (tx) => {
      const { token, base } = await pair(tx);
      const writer = new PriceWriter();
      const at = new Date('2026-03-01T10:00:00Z');
      await writer.writeManual(reading(token, base, '2000', at, { source: 'manual' }), tx);

      const error = await tx
        .transaction((savepoint) =>
          writer.writeManual(reading(token, base, '2100', at, { source: 'manual' }), savepoint)
        )
        .catch((e: unknown) => e);

      expect(sqlState(error)).toBe('23505');
    });
  });

  test('writeManual without a transaction does not compile', () => {
    const writer = new PriceWriter();
    const row = {
      tokenId: 'a',
      baseTokenId: 'b',
      price: '1',
      at: new Date(0),
      granularity: 'intraday',
      source: 'manual',
    } as const;
    // Never called: the line exists for the type checker, which must refuse it.
    const unsafe = () =>
      // @ts-expect-error a person's price is written only inside the caller's transaction
      writer.writeManual(row);
    expect(typeof unsafe).toBe('function');
  });
});

/**
 * One table, both checks. Each text is sent to the writer and inserted
 * directly past it, so the writer and the column cannot drift apart; the
 * engine's own reading is listed beside them, because it is wider.
 */
const TEXTS: ReadonlyArray<{ text: string; stored: boolean }> = [
  { text: ' 1.5', stored: false },
  { text: '1.5 ', stored: false },
  { text: 'NaN', stored: false },
  { text: 'Infinity', stored: false },
  { text: '-1', stored: false },
  { text: '0', stored: false },
  { text: '0.0', stored: false },
  { text: '0x1A', stored: false },
  { text: '0x_1A', stored: false },
  { text: '1_000', stored: false },
  { text: '+1', stored: false },
  { text: '', stored: false },
  { text: 'abc', stored: false },
  { text: '1.5\n', stored: false },
  // Each part is bounded, so a long text is a clean refusal, never a numeric
  // overflow: four exponent digits, or past 64 digits either side of the point.
  // The bound is pinned at its edge: 64 digits are stored and 65 are not.
  { text: '1e1000', stored: false },
  { text: `1${'0'.repeat(64)}`, stored: false },
  { text: `0.${'1'.repeat(65)}`, stored: false },
  { text: `1${'0'.repeat(63)}`, stored: true },
  { text: `0.${'1'.repeat(64)}`, stored: true },
  { text: '1.5', stored: true },
  { text: '0.00000012', stored: true },
  { text: '9.9e-9', stored: true },
  { text: '1E3', stored: true },
  { text: '1e-999', stored: true },
  { text: '42', stored: true },
];

describe('the column refuses what the writer drops', () => {
  test('a zero, negative or unparsable price is dropped and counted', async () => {
    await withTestDb(async (tx) => {
      const base = await makeToken(tx);
      const tokens = await Promise.all(
        ['0', '-5', 'abc', '100'].map(async (price) => ({ token: await makeToken(tx), price }))
      );
      const at = new Date('2026-03-01T10:00:00Z');

      const current = await new PriceWriter().writeCurrent(
        tokens.map(({ token, price }) => reading(token, base, price, at)),
        tx
      );
      const history = await new PriceWriter().writeHistory(
        tokens.map(({ token, price }) =>
          reading(token, base, price, new Date(at.getTime() - DAY), { granularity: 'daily' })
        ),
        tx
      );

      expect([current.written, current.dropped]).toEqual([1, 3]);
      expect([history.written, history.dropped]).toEqual([1, 3]);
      const stored = await storedFor(
        tx,
        tokens.map(({ token }) => token.id)
      );
      expect(stored.map((r) => r.price)).toEqual(['100', '100']);
    });
  });

  test('the column refuses a text the writer would drop', async () => {
    await withTestDb(async (tx) => {
      const { token, base } = await pair(tx);
      const writer = new PriceWriter();
      const at = new Date('2026-03-01T10:00:00Z');
      const verdicts: Array<{ text: string; column: boolean; writer: boolean }> = [];

      for (const [i, { text }] of TEXTS.entries()) {
        const stamp = new Date(at.getTime() + i * HOUR);
        const direct = await tx
          .transaction((savepoint) =>
            savepoint.insert(schema.tokenPrices).values({
              tokenId: token.id,
              baseTokenId: base.id,
              price: text,
              timestamp: stamp,
              granularity: 'daily',
              source: 'direct',
            })
          )
          .then(
            () => 'stored',
            (error: unknown) => sqlState(error)
          );
        if (direct !== 'stored')
          expect({ text, sqlState: direct }).toEqual({ text, sqlState: '23514' });
        const written = await writer.writeHistory(
          [reading(token, base, text, stamp, { granularity: 'intraday' })],
          tx
        );
        verdicts.push({ text, column: direct === 'stored', writer: written.written === 1 });
      }

      expect(verdicts).toEqual(
        TEXTS.map(({ text, stored }) => ({ text, column: stored, writer: stored }))
      );
    });
  });

  test('the engine alone reads six of those texts the column refuses', () => {
    const engineOnly = TEXTS.filter(
      ({ text, stored }) => !stored && positivePrice(text) !== null
    ).map(({ text }) => text);

    expect(engineOnly).toEqual([
      '0x1A',
      '1_000',
      '+1',
      '1e1000',
      `1${'0'.repeat(64)}`,
      `0.${'1'.repeat(65)}`,
    ]);
  });

  test('the migration’s CHECK carries the writer’s pattern, character for character', () => {
    const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(CHECK_MIGRATION));
    expect(files).toHaveLength(1);
    const migration = readFileSync(`${MIGRATIONS}${files[0]}`, 'utf8');

    expect(checkExpressions(migration)).toEqual([
      `CASE WHEN price ~ '${CANONICAL_PRICE_TEXT.source}' THEN price::numeric > 0 ELSE false END`,
    ]);
    expect(CANONICAL_PRICE_TEXT.flags).toBe('');
  });

  test('CONTROL: the pattern in a comment alone is not a CHECK that carries it', () => {
    const quoted = `'${CANONICAL_PRICE_TEXT.source}'`;
    const commentOnly = [
      `-- WHERE NOT (CASE WHEN price ~ ${quoted} THEN price::numeric > 0 ELSE false END);`,
      'ALTER TABLE token_prices ADD CONSTRAINT c CHECK (',
      "  CASE WHEN price ~ '^[0-9]+$' THEN price::numeric > 0 ELSE false END",
      ') NOT VALID;',
    ].join('\n');

    // What a plain search reads, and why it is not the test.
    expect(commentOnly).toContain(quoted);
    expect(checkExpressions(commentOnly)).toEqual([
      "CASE WHEN price ~ '^[0-9]+$' THEN price::numeric > 0 ELSE false END",
    ]);
  });
});
