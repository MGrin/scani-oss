import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { TokenRepository } from '../../src/repositories/TokenRepository';
import { ScamTokenDetectionService } from '../../src/services/tokens/ScamTokenDetectionService';
import { withTestDb } from '../../test/helpers/db';

/**
 * SC-286. Which rows the recompute is allowed to touch — asserted against a
 * real database, because the rule lives in SQL and a test that greps the
 * query source agrees with whatever the query gets wrong.
 *
 * ## Why this file exists
 *
 * The first review of #849 ran the scoring function over all 371 production
 * tokens and found three rows at 0 that would RISE:
 *
 *     0.00 -> 0.50  AMZN     AMAZON.COM INC              (held, in the total)
 *     0.00 -> 0.50  SPCX.TO  SPACE EXPLORATION TECH-CDR
 *     0.00 -> 0.20  XUU      ISHARES CORE S&P US TOTAL MA
 *
 * `SCAM_PROBABILITY_THRESHOLD` is 0.35 and `countsTowardTotal` is false at or
 * above it, so badging AMZN would have subtracted Amazon from the portfolio
 * total — the same harm as `USCON`, on a blue chip.
 *
 * All three are equities, and `TokenIdentityService` scores CRYPTO ONLY. Their
 * stored 0 is not a stale heuristic value, it is the absence of a verdict: the
 * function never ran on them and nothing in this feature should make it start.
 * "AMAZON.COM INC" really does score 0.50 — it contains a literal dot followed
 * by a three-character TLD — and that is not a heuristic to loosen, because
 * equities were never in its scope.
 *
 * So the tests below pin the SELECTION, using the real strings from the
 * measurement. The function's own behaviour is deliberately asserted too: if
 * the heuristic ever stops returning 0.50 for "AMAZON.COM INC", these tests
 * would start passing for the wrong reason.
 */

async function typeByCode(tx: DatabaseTransaction, code: string): Promise<string> {
  const existing = await tx
    .select()
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, code))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const [row] = await tx.insert(schema.tokenTypes).values({ code, name: code }).returning();
  if (!row) throw new Error(`could not create token type ${code}`);
  return row.id;
}

async function insertToken(
  tx: DatabaseTransaction,
  values: Partial<typeof schema.tokens.$inferInsert> & {
    symbol: string;
    name: string;
    typeId: string;
  }
): Promise<typeof schema.tokens.$inferSelect> {
  // A unique `market_segment` per row. The symbol and name have to stay
  // VERBATIM — they are the measurement — but `tokens_symbol_type_segment_unique`
  // is on (symbol, type_id, COALESCE(market_segment,'')), and another suite
  // commits its own `AMZN` stock row. In isolation this file passed; in a full
  // parallel run it collided (the SC-230 class). The segment is the one part of
  // the key nothing else contends for, and scoring never reads it.
  const [row] = await tx
    .insert(schema.tokens)
    .values({
      isScamProbability: 0,
      marketSegment: `sc286-${crypto.randomUUID()}`,
      ...values,
    })
    .returning();
  if (!row) throw new Error('token insert failed');
  return row;
}

const repo = () => Container.get(TokenRepository);
const detector = () => Container.get(ScamTokenDetectionService);

/** The real rows from the production measurement, verbatim. */
const EQUITIES: Array<[string, string]> = [
  ['AMZN', 'AMAZON.COM INC'],
  ['SPCX.TO', 'SPACE EXPLORATION TECH-CDR'],
  ['XUU', 'ISHARES CORE S&P US TOTAL MA'],
];

describe('the recompute population is crypto only, matching the creation gate', () => {
  test('AMZN / AMAZON.COM INC is never handed to the recompute', async () => {
    await withTestDb(async (tx) => {
      const stockType = await typeByCode(tx, 'stock');
      const amzn = await insertToken(tx, {
        symbol: 'AMZN',
        name: 'AMAZON.COM INC',
        typeId: stockType,
        isScamProbability: 0,
        scamScoreVersion: null,
      });

      // The function really would raise it — this is not a token the
      // heuristic happens to be right about, it is one the heuristic was
      // never asked about. 0.50 above the 0.35 threshold means "excluded
      // from the portfolio total".
      expect(detector().calculateScamProbability(amzn.symbol, amzn.name, amzn.createdAt)).toBe(0.5);

      const stale = await repo().findWithStaleScamScore(1, 500, tx);
      expect(stale.map((t) => t.id)).not.toContain(amzn.id);
    });
  });

  test('none of the three rows from the production measurement are selected', async () => {
    await withTestDb(async (tx) => {
      const stockType = await typeByCode(tx, 'stock');
      const ids: string[] = [];
      for (const [symbol, name] of EQUITIES) {
        const t = await insertToken(tx, {
          symbol,
          name,
          typeId: stockType,
          isScamProbability: 0,
          scamScoreVersion: null,
        });
        // Every one of them would move if it were selected.
        expect(detector().calculateScamProbability(t.symbol, t.name, t.createdAt)).toBeGreaterThan(
          0
        );
        ids.push(t.id);
      }

      const stale = await repo().findWithStaleScamScore(1, 500, tx);
      const selected = stale.map((t) => t.id);
      for (const id of ids) expect(selected).not.toContain(id);
    });
  });

  test('a fiat row is not selected either', async () => {
    await withTestDb(async (tx) => {
      const fiatType = await typeByCode(tx, 'fiat');
      // Not 'USD' — the migrations seed that row, and the unique constraint on
      // (symbol, type_id, market_segment) rejects a second one.
      const fiat = await insertToken(tx, {
        symbol: 'ZZFIAT',
        name: 'Synthetic Fiat',
        typeId: fiatType,
        scamScoreVersion: null,
      });
      const stale = await repo().findWithStaleScamScore(1, 500, tx);
      expect(stale.map((t) => t.id)).not.toContain(fiat.id);

      // Nothing NON-CRYPTO is ever in the population — asserted over whatever
      // else is in the database, rather than over an empty one, because a
      // full parallel run has peers' committed rows in it.
      for (const t of stale) {
        const [type] = await tx
          .select()
          .from(schema.tokenTypes)
          .where(eq(schema.tokenTypes.id, t.typeId))
          .limit(1);
        expect(type?.code).toBe('crypto');
      }
    });
  });

  test('a non-crypto row is left ENTIRELY alone — not even stamped', async () => {
    await withTestDb(async (tx) => {
      // Stamping would assert that `calculateScamProbability` produced the
      // stored 0. It never ran. `unscored` is the honest value, and it is
      // what the column defaults to.
      const stockType = await typeByCode(tx, 'stock');
      const amzn = await insertToken(tx, {
        symbol: 'AMZN',
        name: 'AMAZON.COM INC',
        typeId: stockType,
      });
      expect(amzn.scamScoreVersion).toBeNull();
      expect(amzn.scamScoreSource).toBe('unscored');
    });
  });

  test('a stale crypto row IS selected — the filter excludes, it does not disable', async () => {
    await withTestDb(async (tx) => {
      // Without this the four tests above would all pass on a query that
      // returns nothing at all, which is the vacuous version of "AMZN is
      // safe".
      const cryptoType = await typeByCode(tx, 'crypto');
      const uscon = await insertToken(tx, {
        symbol: 'USCON',
        name: 'United States Covert Operations Network',
        typeId: cryptoType,
        isScamProbability: 0.8,
        scamScoreVersion: null,
        scamScoreSource: 'heuristic',
      });
      const stale = await repo().findWithStaleScamScore(1, 500, tx);
      expect(stale.map((t) => t.id)).toContain(uscon.id);
    });
  });
});

describe('what the version and source columns exclude', () => {
  test('a crypto row already at the current version is not reselected', async () => {
    await withTestDb(async (tx) => {
      const cryptoType = await typeByCode(tx, 'crypto');
      const current = await insertToken(tx, {
        symbol: 'CURRENT',
        name: 'Already Scored',
        typeId: cryptoType,
        scamScoreVersion: 1,
        scamScoreSource: 'heuristic',
      });
      const stale = await repo().findWithStaleScamScore(1, 500, tx);
      expect(stale.map((t) => t.id)).not.toContain(current.id);
    });
  });

  test("a user's verdict is never reselected, at any version", async () => {
    await withTestDb(async (tx) => {
      const cryptoType = await typeByCode(tx, 'crypto');
      const marked = await insertToken(tx, {
        symbol: 'USERSCAM',
        name: 'Marked By A Human',
        typeId: cryptoType,
        isScamProbability: 1,
        scamScoreVersion: null,
        scamScoreSource: 'user',
      });
      const stale = await repo().findWithStaleScamScore(1, 500, tx);
      expect(stale.map((t) => t.id)).not.toContain(marked.id);
    });
  });
});
