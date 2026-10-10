import { afterEach, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { RollupPortfolioValueDailyUseCase } from '../../src/use-cases/RollupPortfolioValueDailyUseCase';
import { committedRows } from '../../test/helpers/committed-rows';
import { commitExchange } from '../../test/helpers/committed-seeds';
import { makeHolding } from '../../test/helpers/factories-extra';

/**
 * The 04:00 rollup rewrote each user's chart and told no open app (SC-1600).
 * Its processor can tell them only if the run says whose chart it wrote, so
 * the summary names every user with at least one day computed.
 *
 * In its own file because PR-7 (#2276) rewrites the main rollup test (feeds,
 * #22607).
 */

const rows = committedRows();
afterEach(() => rows.drop());

const RUN_START = new Date('2026-09-26T12:00:00.000Z');

async function usd(): Promise<string> {
  const [token] = await getDb()
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(eq(schema.tokens.symbol, 'USD'))
    .limit(1);
  if (!token) throw new Error('USD token not seeded');
  return token.id;
}

/** A user with a USD holding, and a base currency unless `baseCurrency` is false. */
async function seedUser({ baseCurrency }: { baseCurrency: boolean }) {
  const usdId = await usd();
  const exchange = await commitExchange(rows);
  await getDb().transaction(async (tx) => {
    if (baseCurrency) {
      await tx
        .update(schema.users)
        .set({ baseCurrencyId: usdId })
        .where(eq(schema.users.id, exchange.userId));
    }
    await makeHolding(tx, {
      userId: exchange.userId,
      accountId: exchange.account.id,
      tokenId: usdId,
      balance: '100',
      createdAt: new Date(RUN_START.getTime() - 10 * 86_400_000),
    });
  });
  return exchange.userId;
}

const rollUp = (userId: string) =>
  Container.get(RollupPortfolioValueDailyUseCase).execute({
    userId,
    lookbackDays: 3,
    runStart: RUN_START,
  });

describe('RollupSummary.rolledUpUserIds (SC-1600)', () => {
  test('a user whose rollup wrote days is named', async () => {
    const userId = await seedUser({ baseCurrency: true });
    const summary = await rollUp(userId);
    expect(summary.daysComputed).toBeGreaterThan(0);
    expect(summary.rolledUpUserIds).toEqual([userId]);
  });

  // The rollup writes a day for every user with a base currency, holdings or
  // not, so the user it does not name is one it skips: no base currency.
  test('control: a user the rollup skips is not named', async () => {
    const userId = await seedUser({ baseCurrency: false });
    const summary = await rollUp(userId);
    expect({ daysComputed: summary.daysComputed, named: summary.rolledUpUserIds }).toEqual({
      daysComputed: 0,
      named: [],
    });
  });
});
