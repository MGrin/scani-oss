/**
 * SC-149 / SC-151 end to end, against a real database and with nothing stubbed.
 *
 * Every other test for this work stubs a seam. This one does not: real
 * `holding_coverage` rows, real `token_prices` rows, the real
 * `CostBasisService` / `PriceGraphService` / `PortfolioValuationAtTimeService`
 * chain. That matters because both defects were *wiring* defects — each signal
 * was computed correctly and then dropped between two layers — and a suite
 * built entirely from stubs is the kind that would have passed on the broken
 * code, since the broken code computed all the right numbers.
 *
 * The fixture is deliberately a matched pair, four holdings:
 *
 *   truncated + stale   Kraken-shaped: coverage says the history is not
 *                       complete, and its last quote is 96 days old — the age
 *                       measured on the SC-90 fixture, where an airdrop dated
 *                       2025-11-05 was valued from a price dated 2025-08-01
 *                       and printed as market value on the day.
 *   truncated + fresh   isolates the history flag.
 *   complete  + stale   isolates the price age.
 *   complete  + fresh   the control. Nothing about it should be qualified.
 *
 * Without the two `complete + fresh` and `truncated + fresh` arms, a test could
 * pass by flagging everything, which is its own kind of dishonesty.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { PnLAtTimeService } from '../../../src/services/portfolio/PnLAtTimeService';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Older than MAX_INTRADAY_PRICE_AGE_MS (7d) and MAX_DAILY_PRICE_AGE_MS (45d). */
const STALE_AGE_DAYS = 96;

interface Fixture {
  userId: string;
  baseCurrencyId: string;
  tokenTypeId: string;
  institutionTypeId: string;
  institutionId: string;
  accountTypeId: string;
  tokenIds: string[];
  holdings: Record<string, string>;
}

let fixture: Fixture | null = null;

interface HoldingSpec {
  key: string;
  historyComplete: boolean;
  priceAgeDays: number;
}

const SPECS: HoldingSpec[] = [
  { key: 'truncated-stale', historyComplete: false, priceAgeDays: STALE_AGE_DAYS },
  { key: 'truncated-fresh', historyComplete: false, priceAgeDays: 0 },
  { key: 'complete-stale', historyComplete: true, priceAgeDays: STALE_AGE_DAYS },
  { key: 'complete-fresh', historyComplete: true, priceAgeDays: 0 },
];

async function setupFixture(): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 6);
  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `pnlq-${suffix}`, name: 'PnLQ Token Type' })
    .returning();
  const [baseCurrency] = await db
    .insert(schema.tokens)
    .values({
      symbol: `PQB${suffix.toUpperCase()}`,
      name: 'PnLQ Base',
      typeId: tokenType!.id,
    })
    .returning();
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `pnlq-${randomUUID().slice(0, 8)}@scani.local`,
      name: 'PnLQ User',
      baseCurrencyId: baseCurrency!.id,
    })
    .returning();
  const [institutionType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `pnlq-i-${suffix}`, name: 'PnLQ Institution Type' })
    .returning();
  const [institution] = await db
    .insert(schema.institutions)
    .values({ name: 'PnLQ Institution', typeId: institutionType!.id })
    .returning();
  const [accountType] = await db
    .insert(schema.accountTypes)
    .values({ code: `pnlq-a-${suffix}`, name: 'PnLQ Account Type' })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({
      userId: user!.id,
      institutionId: institution!.id,
      name: 'PnLQ Account',
      typeId: accountType!.id,
    })
    .returning();

  const now = Date.now();
  const tokenIds: string[] = [];
  const holdings: Record<string, string> = {};

  for (const spec of SPECS) {
    const [token] = await db
      .insert(schema.tokens)
      .values({
        symbol: `PQ${spec.key.slice(0, 2).toUpperCase()}${randomUUID().toUpperCase()}`,
        name: `PnLQ ${spec.key}`,
        typeId: tokenType!.id,
      })
      .returning();
    tokenIds.push(token!.id);

    const [holding] = await db
      .insert(schema.holdings)
      .values({
        userId: user!.id,
        accountId: account!.id,
        tokenId: token!.id,
        balance: '10',
      })
      .returning();
    holdings[spec.key] = holding!.id;

    // One acquisition, priced in the base currency so the walk needs no FX —
    // every holding therefore has an identical, fully-known cost basis of 500.
    // Any difference in the output is the *grade*, never the arithmetic.
    await db.insert(schema.holdingTransactions).values({
      userId: user!.id,
      holdingId: holding!.id,
      tokenId: token!.id,
      kind: 'buy',
      quantity: '10',
      priceNative: '50',
      priceNativeTokenId: baseCurrency!.id,
      occurredAt: new Date(now - 200 * DAY_MS),
      externalId: `pnlq-${spec.key}-${suffix}`,
      source: 'test',
    });

    // The flag every provider writes honestly. `false` is what Kraken reports
    // once its ledger endpoint pages out at 20,000 rows.
    await db.insert(schema.holdingCoverage).values({
      holdingId: holding!.id,
      hasCompleteTxHistory: spec.historyComplete,
    });

    await db.insert(schema.tokenPrices).values({
      tokenId: token!.id,
      baseTokenId: baseCurrency!.id,
      price: '60',
      timestamp: new Date(now - spec.priceAgeDays * DAY_MS),
      granularity: 'daily',
      source: 'test',
    });
  }

  return {
    userId: user!.id,
    baseCurrencyId: baseCurrency!.id,
    tokenTypeId: tokenType!.id,
    institutionTypeId: institutionType!.id,
    institutionId: institution!.id,
    accountTypeId: accountType!.id,
    tokenIds,
    holdings,
  };
}

async function cleanupFixture(f: Fixture): Promise<void> {
  await db
    .delete(schema.portfolioValueDaily)
    .where(eq(schema.portfolioValueDaily.userId, f.userId));
  await db.delete(schema.users).where(eq(schema.users.id, f.userId));
  await db
    .delete(schema.tokenPrices)
    .where(inArray(schema.tokenPrices.tokenId, [...f.tokenIds, f.baseCurrencyId]));
  await db
    .delete(schema.tokens)
    .where(inArray(schema.tokens.id, [...f.tokenIds, f.baseCurrencyId]));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
  await db
    .delete(schema.institutionTypes)
    .where(eq(schema.institutionTypes.id, f.institutionTypeId));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
}

beforeEach(async () => {
  fixture = await setupFixture();
});

afterEach(async () => {
  if (fixture) await cleanupFixture(fixture);
  fixture = null;
});

describe('PnL quality signals, end to end', () => {
  test('the truncated import and the 96-day-old price both reach the result', async () => {
    const f = fixture!;
    const result = await Container.get(PnLAtTimeService).getPnL(
      f.userId,
      new Date(),
      f.baseCurrencyId
    );

    const byKey = (key: string) => result.perHolding.find((ph) => ph.holdingId === f.holdings[key]);

    // The control: complete history, quote from today. Nothing to qualify.
    expect(byKey('complete-fresh')?.basisQuality).toBe('known');
    expect(byKey('complete-fresh')?.priceStale).toBe(false);

    // `has_complete_tx_history = false`, read for the first time.
    expect(byKey('truncated-fresh')?.basisQuality).toBe('partial');
    expect(byKey('truncated-fresh')?.priceStale).toBe(false);

    // A price 96 days old is still used for the value — and is no longer
    // indistinguishable from one quoted this morning.
    expect(byKey('complete-stale')?.priceStale).toBe(true);
    expect(byKey('truncated-stale')?.priceStale).toBe(true);

    expect(result.holdingsStalePriced).toBe(2);
    expect(result.holdingsBasisUnknown).toBe(2);
    expect(result.holdingsTotal).toBe(4);
    expect(result.holdingsWithKnownValue).toBe(4);

    // Every holding priced, and the day is still not 'full'.
    expect(result.coverageQuality).toBe('partial');
  });

  test('the figures themselves are unchanged — this is about what is said, not withheld', async () => {
    const f = fixture!;
    const result = await Container.get(PnLAtTimeService).getPnL(
      f.userId,
      new Date(),
      f.baseCurrencyId
    );

    // 4 holdings × 10 units × 50 = 2000 of cost; × 60 = 2400 of value.
    expect(result.totalCostBasis.toString()).toBe('2000');
    expect(result.totalValueInBase.toString()).toBe('2400');
    expect(result.totalUnrealizedPnl.toString()).toBe('400');

    // The whole point: a run with every flag raised produces exactly the
    // numbers a run with none would. Before this, that identity was the bug —
    // there was no second channel saying which of the two you were reading.
    for (const ph of result.perHolding) {
      expect(ph.costBasis.toString()).toBe('500');
    }
  });

  test('a holding with no coverage row is not flagged as truncated', async () => {
    const f = fixture!;
    // ~22% of production holdings have no `holding_coverage` row: manual
    // entries, older file imports. Grading those `partial` would flag more
    // holdings than the deliberate `false` does and bury the real signal.
    await db
      .delete(schema.holdingCoverage)
      .where(eq(schema.holdingCoverage.holdingId, f.holdings['truncated-fresh']!));

    const result = await Container.get(PnLAtTimeService).getPnL(
      f.userId,
      new Date(),
      f.baseCurrencyId
    );
    const row = result.perHolding.find((ph) => ph.holdingId === f.holdings['truncated-fresh']);
    expect(row?.basisQuality).toBe('known');
    expect(result.holdingsBasisUnknown).toBe(1);
  });

  /**
   * SC-160, in the same unstubbed chain and for the same reason the tests
   * above it are written this way: this is a wiring problem. The count is
   * computed correctly inside `CostBasisService` — its own suite proves that
   * — and the failure mode worth guarding is it being dropped between the
   * walk and the result, which is precisely what happened to SC-151's
   * stale-price flag for two tickets while every unit test stayed green.
   *
   * The withdrawal is answered in the second half rather than removed,
   * because a count that never falls is a caveat the reader cannot clear and
   * would be its own defect. `left_control` also realizes the gain, so the
   * two assertions together say the figure and its caveat move as one.
   */
  test('an unanswered withdrawal is counted, and answering it clears the count', async () => {
    const f = fixture!;
    const holdingId = f.holdings['complete-fresh']!;
    const [holding] = await db
      .select({ tokenId: schema.holdings.tokenId })
      .from(schema.holdings)
      .where(eq(schema.holdings.id, holdingId))
      .limit(1);

    const [withdrawal] = await db
      .insert(schema.holdingTransactions)
      .values({
        userId: f.userId,
        holdingId,
        tokenId: holding!.tokenId,
        kind: 'withdraw',
        quantity: '-4',
        priceNative: '60',
        priceNativeTokenId: f.baseCurrencyId,
        occurredAt: new Date(Date.now() - DAY_MS),
        externalId: `pnlq-withdraw-${randomUUID().slice(0, 8)}`,
        source: 'test',
      })
      .returning();

    const unanswered = await Container.get(PnLAtTimeService).getPnL(
      f.userId,
      new Date(),
      f.baseCurrencyId
    );
    expect(unanswered.transfersUnreviewed).toBe(1);
    expect(
      unanswered.perHolding.find((ph) => ph.holdingId === holdingId)?.transfersUnreviewed
    ).toBe(1);
    // SC-150's behaviour, restated here because the caveat only means
    // something if it is describing a figure that really is short: nothing was
    // realized on the way out.
    expect(unanswered.totalRealizedPnl.toString()).toBe('0');

    await db
      .update(schema.holdingTransactions)
      .set({ transferReview: 'left_control', transferReviewedAt: new Date() })
      .where(eq(schema.holdingTransactions.id, withdrawal!.id));

    const answered = await Container.get(PnLAtTimeService).getPnL(
      f.userId,
      new Date(),
      f.baseCurrencyId
    );
    expect(answered.transfersUnreviewed).toBe(0);
    // 4 units bought at 50, sold at 60 — the gain the caveat was standing in
    // for, now booked.
    expect(answered.totalRealizedPnl.toString()).toBe('40');
  });
});
