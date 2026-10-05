import { describe, expect, test } from 'bun:test';
import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { sql } from 'drizzle-orm';
import { withTestDb } from '../../test/helpers/db';
import { makeToken } from '../../test/helpers/factories-extra';
import { liftPriceCheck } from '../../test/helpers/price-check';

/**
 * `liftPriceCheck` drops the CHECK on `token_prices.price` so a reader's
 * defence can be shown a row the column refuses. A DROP CONSTRAINT is
 * transactional, so it must end with the test's transaction: a lift that
 * outlived it would let every later test, and the suite, write what the
 * column exists to refuse.
 */

const CHECK = 'token_prices_price_positive_decimal_chk';

/** Inserts a NaN price and answers the SQLSTATE it failed with, or 'stored'. */
async function insertNaN(tx: DatabaseTransaction): Promise<string> {
  const token = await makeToken(tx);
  const base = await makeToken(tx);
  return tx
    .transaction((savepoint) =>
      savepoint.insert(schema.tokenPrices).values({
        tokenId: token.id,
        baseTokenId: base.id,
        price: 'NaN',
        timestamp: new Date('2026-03-01T10:00:00Z'),
        source: 'direct',
      })
    )
    .then(
      () => 'stored',
      (error: { code?: string; cause?: { code?: string } }) =>
        error.code ?? error.cause?.code ?? 'unknown'
    );
}

async function checkState(): Promise<Array<{ validated: boolean }>> {
  return (await getDb().execute(sql`
    SELECT convalidated AS validated FROM pg_constraint
     WHERE conrelid = 'token_prices'::regclass AND conname = ${CHECK}
  `)) as unknown as Array<{ validated: boolean }>;
}

describe('liftPriceCheck', () => {
  test('the CHECK is lifted inside the test’s transaction and stands again after it', async () => {
    expect(await checkState()).toEqual([{ validated: true }]);

    const inside = await withTestDb(async (tx) => {
      // CONTROL: before the lift the column refuses, so the lift is what lets it in.
      const before = await insertNaN(tx);
      await liftPriceCheck(tx);
      return { before, lifted: await insertNaN(tx) };
    });

    expect(inside).toEqual({ before: '23514', lifted: 'stored' });
    expect(await checkState()).toEqual([{ validated: true }]);
    expect(await withTestDb(insertNaN)).toBe('23514');
  });
});
