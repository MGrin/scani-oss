/**
 * SC-1546. A holding the closed-position sweep hid still counts in value
 * history and PnL (SC-1486), so the row the rollup stores for a day must be
 * what `getPnL` answers for that instant when nobody hands it anything.
 *
 * Unstubbed on purpose: the defect was between the rollup's preload and the
 * valuation's own holding list, and a stub on either side is the seam it
 * lived in.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import Decimal from 'decimal.js';
import { and, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../src/repositories/HoldingBalanceObservationRepository';
import { HoldingTransactionRepository } from '../../src/repositories/HoldingTransactionRepository';
import { PortfolioValueDailyRepository } from '../../src/repositories/PortfolioValueDailyRepository';
import {
  type PnLAtTimeResult,
  PnLAtTimeService,
} from '../../src/services/portfolio/PnLAtTimeService';
import { RollupPortfolioValueDailyUseCase } from '../../src/use-cases/RollupPortfolioValueDailyUseCase';

const DAY = 86_400_000;
const HOUR = 3_600_000;
// Fixed, so the same fixture writes the same rows on every run.
const RUN_START = new Date('2026-09-26T12:00:00.000Z');
const DAY0 = Date.UTC(2026, 8, 26);
const LOOKBACK = 10;
const ago = (days: number, hour = 0) => new Date(DAY0 - days * DAY + hour * HOUR);

// The instants the rollup values, newest first: `RUN_START` itself, then the
// last millisecond of each earlier day.
const DAYS = Array.from({ length: LOOKBACK }, (_, i) => {
  const at = new Date(RUN_START.getTime() - i * DAY);
  if (i > 0) at.setUTCHours(23, 59, 59, 999);
  return { at, snapshotDate: at.toISOString().slice(0, 10) };
});

interface Closed {
  isHidden: boolean;
  hiddenBy: 'user' | 'auto' | null;
  /**
   * `true` is the two readings described on `setupFixture`. The other two are
   * a single reading, taken before the window opens:
   *   one             0, after the sale.
   *   one-while-held  10, between the purchase and the sale.
   */
  readings: boolean | 'one' | 'one-while-held';
  /**
   * Units the sale sells, when not all ten. The ledger then leaves the rest
   * held, which a reading of 0 after the sale contradicts.
   */
  sold?: string;
  /** `holding_coverage` says the import did not reach the start of the history. */
  truncated?: boolean;
  /**
   * How the ten units left, when not by the sale before the window:
   *   sold-in-window  the same sale, made on the window's fifth day, so the
   *                   holding is worth something on the four days before it.
   *   moved           no sale. Bought on day -40 and transferred whole on day
   *                   -20 to `moved`, a visible holding of the same token on
   *                   a second account. The token is priced 150 that day.
   */
  exit?: 'sold-in-window' | 'moved';
  /** Its token has no price row and sits in a pricing cooldown. */
  unpriceable?: boolean;
}

interface Fixture {
  userId: string;
  usdId: string;
  closedHoldingId: string;
  keptHoldingId: string;
  dormantHoldingId: string;
  /** Only when `closed` left by `moved`. */
  movedHoldingId: string | null;
  tokenTypeId: string;
  tokenIds: string[];
  institutionId: string;
  institutionTypeId: string;
  accountTypeId: string;
}

interface HoldingSpec {
  name: string;
  tokenId: string;
  accountId: string;
  balance: string;
  isHidden: boolean;
  hiddenBy: 'user' | 'auto' | null;
  isActive: boolean;
  trades: Array<{
    kind: string;
    quantity: string;
    priceNative?: string;
    at: Date;
    transferGroupId?: string;
  }>;
  readings: Array<{ balance: string; at: Date }>;
}

const fixtures: Fixture[] = [];

/**
 * Three holdings on one account:
 *   closed   bought 10 at 100, sold all 10 at 150 before the window opens:
 *            500 realized, nothing left. Its two readings (10, then 0) say
 *            what the ledger already explains, and the second falls inside
 *            the window, so half its days sit between the two.
 *   kept     bought 5 at 20 and still held, so every total has something in
 *            it that is not the holding under test.
 *   dormant  visible and inactive: the rollup lists it and the totals do not.
 */
async function setupFixture(closed: Closed): Promise<Fixture> {
  const [usd] = await db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(eq(schema.tokens.symbol, 'USD'))
    .limit(1);
  if (!usd) throw new Error('USD token not seeded');

  const tag = randomUUID().slice(0, 6);
  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `rpvh-${tag}`, name: 'RPVH Token Type' })
    .returning();
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `rpvh-${randomUUID().slice(0, 8)}@scani.local`,
      name: 'RPVH User',
      baseCurrencyId: usd.id,
    })
    .returning();
  const [institutionType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `rpvh-inst-${tag}`, name: 'RPVH Institution Type' })
    .returning();
  const [institution] = await db
    .insert(schema.institutions)
    .values({ name: 'RPVH Institution', typeId: institutionType!.id })
    .returning();
  const [accountType] = await db
    .insert(schema.accountTypes)
    .values({ code: `rpvh-acct-${tag}`, name: 'RPVH Account Type' })
    .returning();
  const newAccount = async (name: string) => {
    const [account] = await db
      .insert(schema.accounts)
      .values({
        userId: user!.id,
        institutionId: institution!.id,
        name,
        typeId: accountType!.id,
      })
      .returning();
    return account!.id;
  };
  const accountId = await newAccount('RPVH Account');

  const tokenIds: string[] = [];
  /** A token priced daily from `price` up, or never priced and cooling down. */
  const newToken = async (name: string, price: number | null) => {
    const [token] = await db
      .insert(schema.tokens)
      .values({
        symbol: `RPVH${name.toUpperCase()}${randomUUID().toUpperCase()}`,
        name: `RPVH ${name}`,
        typeId: tokenType!.id,
        unpriceableUntil: price === null ? new Date('2100-01-01T00:00:00.000Z') : null,
      })
      .returning();
    tokenIds.push(token!.id);
    if (price !== null) {
      await db.insert(schema.tokenPrices).values(
        Array.from({ length: 40 }, (_, i) => ({
          tokenId: token!.id,
          baseTokenId: usd.id,
          price: String(price + ((i * 7) % 11)),
          timestamp: ago(i),
          granularity: 'daily' as const,
          source: 'rpvh-test',
        }))
      );
    }
    return token!.id;
  };

  const moved = closed.exit === 'moved';
  const transferGroupId = randomUUID();
  // 142 on the newest day is 150 on day -20, the day the units move.
  const closedTokenId = await newToken('closed', closed.unpriceable ? null : moved ? 142 : 120);
  const specs: HoldingSpec[] = [
    {
      name: 'closed',
      tokenId: closedTokenId,
      accountId,
      balance: '0',
      isHidden: closed.isHidden,
      hiddenBy: closed.hiddenBy,
      isActive: true,
      trades: moved
        ? [
            { kind: 'buy', quantity: '10', priceNative: '100', at: ago(40, 10) },
            { kind: 'transfer_out', quantity: '-10', at: ago(20, 10), transferGroupId },
          ]
        : [
            { kind: 'buy', quantity: '10', priceNative: '100', at: ago(20, 10) },
            {
              kind: 'sell',
              quantity: `-${closed.sold ?? '10'}`,
              priceNative: '150',
              at: closed.exit === 'sold-in-window' ? ago(5, 10) : ago(12, 10),
            },
          ],
      readings:
        closed.readings === 'one'
          ? [{ balance: '0', at: ago(11, 8) }]
          : closed.readings === 'one-while-held'
            ? [{ balance: '10', at: ago(16, 8) }]
            : closed.readings
              ? [
                  { balance: '10', at: moved ? ago(30, 8) : ago(16, 8) },
                  { balance: '0', at: ago(4, 8) },
                ]
              : [],
    },
    {
      name: 'kept',
      tokenId: await newToken('kept', 20),
      accountId,
      balance: '5',
      isHidden: false,
      hiddenBy: null,
      isActive: true,
      trades: [{ kind: 'buy', quantity: '5', priceNative: '20', at: ago(30, 10) }],
      readings: [{ balance: '5', at: ago(25, 8) }],
    },
    {
      name: 'dormant',
      tokenId: await newToken('dormant', 7),
      accountId,
      balance: '3',
      isHidden: false,
      hiddenBy: null,
      isActive: false,
      trades: [{ kind: 'buy', quantity: '3', priceNative: '7', at: ago(30, 10) }],
      readings: [],
    },
  ];
  if (moved) {
    specs.push({
      name: 'moved',
      tokenId: closedTokenId,
      accountId: await newAccount('RPVH Second Account'),
      balance: '10',
      isHidden: false,
      hiddenBy: null,
      isActive: true,
      trades: [{ kind: 'transfer_in', quantity: '10', at: ago(20, 10), transferGroupId }],
      readings: [],
    });
  }

  const holdingIds: string[] = [];
  for (const spec of specs) {
    const [holding] = await db
      .insert(schema.holdings)
      .values({
        userId: user!.id,
        accountId: spec.accountId,
        tokenId: spec.tokenId,
        balance: spec.balance,
        isHidden: spec.isHidden,
        hiddenBy: spec.hiddenBy,
        isActive: spec.isActive,
        createdAt: ago(31),
        lastUpdated: ago(4, 8),
      })
      .returning();
    holdingIds.push(holding!.id);
    await db.insert(schema.holdingTransactions).values(
      spec.trades.map((t, k) => ({
        userId: user!.id,
        holdingId: holding!.id,
        tokenId: spec.tokenId,
        kind: t.kind,
        quantity: t.quantity,
        priceNative: t.priceNative,
        priceNativeTokenId: t.priceNative ? usd.id : null,
        transferGroupId: t.transferGroupId,
        occurredAt: t.at,
        externalId: `rpvh-${spec.name}-${k}`,
        source: 'rpvh-test',
      }))
    );
    if (spec.readings.length > 0) {
      await db.insert(schema.holdingBalanceObservations).values(
        spec.readings.map((r) => ({
          userId: user!.id,
          holdingId: holding!.id,
          balance: r.balance,
          observedAt: r.at,
          source: 'sync-capture',
        }))
      );
    }
  }

  if (closed.truncated) {
    await db
      .insert(schema.holdingCoverage)
      .values({ holdingId: holdingIds[0]!, hasCompleteTxHistory: false });
  }

  const fixture: Fixture = {
    userId: user!.id,
    usdId: usd.id,
    closedHoldingId: holdingIds[0]!,
    keptHoldingId: holdingIds[1]!,
    dormantHoldingId: holdingIds[2]!,
    movedHoldingId: holdingIds[3] ?? null,
    tokenTypeId: tokenType!.id,
    tokenIds,
    institutionId: institution!.id,
    institutionTypeId: institutionType!.id,
    accountTypeId: accountType!.id,
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await db
      .delete(schema.portfolioValueDaily)
      .where(eq(schema.portfolioValueDaily.userId, f.userId));
    await db.delete(schema.users).where(eq(schema.users.id, f.userId));
    await db.delete(schema.tokenPrices).where(inArray(schema.tokenPrices.tokenId, f.tokenIds));
    await db.delete(schema.tokens).where(inArray(schema.tokens.id, f.tokenIds));
    await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
    await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
    await db
      .delete(schema.institutionTypes)
      .where(eq(schema.institutionTypes.id, f.institutionTypeId));
    await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
  }
});

const rollUp = (f: Fixture) =>
  Container.get(RollupPortfolioValueDailyUseCase).execute({
    userId: f.userId,
    lookbackDays: LOOKBACK,
    runStart: RUN_START,
  });

/** Every figure the user-scope row stores from one `getPnL` answer. */
function figuresOf(r: PnLAtTimeResult) {
  return {
    totalValue: r.totalValueInBase.toString(),
    costBasis: r.totalCostBasis.toString(),
    realizedPnl: r.totalRealizedPnl.toString(),
    unrealizedPnl: r.totalUnrealizedPnl.toString(),
    coverageQuality: r.coverageQuality,
    holdingsWithKnownValue: r.holdingsWithKnownValue,
    holdingsTotal: r.holdingsTotal,
    holdingsUnpriceable: r.holdingsUnpriceable,
    holdingsStalePriced: r.holdingsStalePriced,
    holdingsStaleAnchored: r.holdingsStaleAnchored,
    oldestAnchorAt: r.oldestAnchorAt?.toISOString() ?? null,
    holdingsBeforeRecords: r.holdingsBeforeRecords,
    holdingsInterpolated: r.holdingsInterpolated,
    holdingsBasisUnknown: r.holdingsBasisUnknown,
    transfersUnreviewed: r.transfersUnreviewed,
  };
}

/** The same figures off stored rows, one entry per day of the window. */
function storedFigures(rows: Array<typeof schema.portfolioValueDaily.$inferSelect>) {
  const byDate = new Map(rows.map((r) => [String(r.snapshotDate).slice(0, 10), r]));
  return DAYS.map(({ snapshotDate }) => {
    const r = byDate.get(snapshotDate);
    if (!r) return { snapshotDate, missing: true };
    return {
      snapshotDate,
      totalValue: r.totalValue,
      costBasis: r.costBasis,
      realizedPnl: r.realizedPnl,
      unrealizedPnl: r.unrealizedPnl,
      coverageQuality: r.coverageQuality,
      holdingsWithKnownValue: r.holdingsWithKnownValue,
      holdingsTotal: r.holdingsTotal,
      holdingsUnpriceable: r.holdingsUnpriceable,
      holdingsStalePriced: r.holdingsStalePriced,
      holdingsStaleAnchored: r.holdingsStaleAnchored,
      oldestAnchorAt: r.oldestAnchorAt?.toISOString() ?? null,
      holdingsBeforeRecords: r.holdingsBeforeRecords,
      holdingsInterpolated: r.holdingsInterpolated,
      holdingsBasisUnknown: r.holdingsBasisUnknown,
      transfersUnreviewed: r.transfersUnreviewed,
    };
  });
}

/** What the rollup stored for the user scope. */
async function storedUserFigures(f: Fixture) {
  return storedFigures(
    await db
      .select()
      .from(schema.portfolioValueDaily)
      .where(
        and(
          eq(schema.portfolioValueDaily.userId, f.userId),
          eq(schema.portfolioValueDaily.scopeKind, 'user')
        )
      )
  );
}

/** `getPnL` asked afresh for each of those instants, handed nothing. */
async function adHocUserFigures(f: Fixture) {
  const pnl = Container.get(PnLAtTimeService);
  const out = [];
  for (const { at, snapshotDate } of DAYS) {
    out.push({
      snapshotDate,
      ...figuresOf(await pnl.getPnL(f.userId, at, f.usdId, { tx: undefined })),
    });
  }
  return out;
}

/** The `holding`-scope rows the rollup wrote for one holding. */
function holdingRows(f: Fixture, holdingId: string) {
  return db
    .select()
    .from(schema.portfolioValueDaily)
    .where(
      and(
        eq(schema.portfolioValueDaily.userId, f.userId),
        eq(schema.portfolioValueDaily.scopeKind, 'holding'),
        eq(schema.portfolioValueDaily.scopeId, holdingId)
      )
    );
}

/** One holding's own row for the window day `daysAgo` days back. */
async function holdingRowOn(f: Fixture, holdingId: string, daysAgo: number) {
  const { snapshotDate } = DAYS[daysAgo]!;
  return (await holdingRows(f, holdingId)).find(
    (r) => String(r.snapshotDate).slice(0, 10) === snapshotDate
  );
}

/**
 * A swept holding with one reading: its user row is what `getPnL` answers ad
 * hoc, and its own rows are what the same holding stores when it is shown.
 */
async function expectStoredAsAdHocAndAsShown(
  closed: Pick<Closed, 'readings' | 'sold'>,
  realizedPnl = '500'
) {
  const swept = await setupFixture({ isHidden: true, hiddenBy: 'auto', ...closed });
  const shown = await setupFixture({ isHidden: false, hiddenBy: null, ...closed });
  await rollUp(swept);
  await rollUp(shown);

  const adHoc = await adHocUserFigures(swept);
  expect(adHoc[0]?.realizedPnl).toBe(realizedPnl);
  expect(await storedUserFigures(swept)).toEqual(adHoc);

  const shownRows = storedFigures(await holdingRows(shown, shown.closedHoldingId));
  // Every day present and the gain on it, or equality below compares nothing.
  expect(shownRows.filter((day) => 'missing' in day)).toEqual([]);
  expect(shownRows[0]).toMatchObject({ totalValue: '0', realizedPnl });
  expect(storedFigures(await holdingRows(swept, swept.closedHoldingId))).toEqual(shownRows);
}

describe('RollupPortfolioValueDailyUseCase: a sweep-hidden holding (SC-1546)', () => {
  test('a sweep-hidden holding with readings is stored as getPnL answers ad hoc', async () => {
    const f = await setupFixture({ isHidden: true, hiddenBy: 'auto', readings: true });
    await rollUp(f);

    const adHoc = await adHocUserFigures(f);
    // The fixture must actually realize the gain, or equality proves nothing.
    expect(adHoc[0]?.realizedPnl).toBe('500');
    expect(adHoc[0]?.holdingsTotal).toBe(2);
    expect(await storedUserFigures(f)).toEqual(adHoc);
  });

  test('control A: the same holding left visible is stored as getPnL answers ad hoc', async () => {
    const f = await setupFixture({ isHidden: false, hiddenBy: null, readings: true });
    await rollUp(f);

    const adHoc = await adHocUserFigures(f);
    expect(adHoc[0]?.realizedPnl).toBe('500');
    expect(adHoc[0]?.holdingsTotal).toBe(2);
    expect(await storedUserFigures(f)).toEqual(adHoc);
  });

  for (const hiddenBy of ['user', null] as const) {
    test(`control B: hidden by its owner (hiddenBy ${hiddenBy}), it counts nowhere`, async () => {
      const f = await setupFixture({ isHidden: true, hiddenBy, readings: true });
      await rollUp(f);

      const adHoc = await adHocUserFigures(f);
      // Only `kept` is left: no gain realized, one holding.
      expect(adHoc[0]?.realizedPnl).toBe('0');
      expect(adHoc[0]?.holdingsTotal).toBe(1);
      expect(await storedUserFigures(f)).toEqual(adHoc);
    });
  }

  test('control C: a sweep-hidden holding with no readings is stored as getPnL answers ad hoc', async () => {
    const f = await setupFixture({ isHidden: true, hiddenBy: 'auto', readings: false });
    await rollUp(f);

    const adHoc = await adHocUserFigures(f);
    expect(adHoc[0]?.realizedPnl).toBe('500');
    expect(adHoc[0]?.holdingsTotal).toBe(2);
    expect(await storedUserFigures(f)).toEqual(adHoc);
  });

  // A reading of 0 against a ledger read as empty leaves nothing unexplained,
  // so no drift row stood in for the missing ledger: the cost walk, handed no
  // rows for the holding, read its ledger itself and the totals came out
  // right. What such a holding lacked was a row of its own.
  test('a sweep-hidden holding with one reading is stored as getPnL answers ad hoc, and its own rows as when it is shown', async () => {
    await expectStoredAsAdHocAndAsShown({ readings: 'one' });
  });

  // The same reading of 0, over a ledger that does not net to it: the sale
  // leaves half a unit held, which the reading says is gone.
  test('a sweep-hidden holding whose one reading of 0 follows a sale of 9.5 of its 10 units is stored as getPnL answers ad hoc, and its own rows as when it is shown', async () => {
    await expectStoredAsAdHocAndAsShown({ readings: 'one', sold: '9.5' }, '475');
  });

  // The same single reading, taken while the ten units were still held. With
  // the ledger missing nothing explains those ten, so they opened as money in
  // and the walk went on from that row alone: no purchase, no sale, no gain.
  test('a sweep-hidden holding with one reading taken while it held units is stored as getPnL answers ad hoc, and its own rows as when it is shown', async () => {
    await expectStoredAsAdHocAndAsShown({ readings: 'one-while-held' });
  });

  // Moving a position out is the ordinary way it reaches zero and gets swept.
  // The units keep the cost they were bought at only when the holding they
  // left and the one they reached are walked together, which takes both
  // ledgers: with the swept one missing, the arrival opened a fresh lot at
  // that day's price.
  for (const readings of [false, true]) {
    test(`a sweep-hidden holding whose units moved to a visible one is stored as getPnL answers ad hoc (${readings ? 'with' : 'no'} readings)`, async () => {
      const f = await setupFixture({ isHidden: true, hiddenBy: 'auto', readings, exit: 'moved' });
      await rollUp(f);

      const adHoc = await adHocUserFigures(f);
      expect(adHoc[0]?.holdingsTotal).toBe(3);
      expect(await storedUserFigures(f)).toEqual(adHoc);

      // Ten units bought at 100 each, not ten arriving at 150.
      const moved = await holdingRows(f, f.movedHoldingId!);
      expect(moved.map((r) => r.costBasis)).toEqual(Array(LOOKBACK).fill('1000'));
    });
  }

  // Sold on the window's fifth day (day -5), so the swept holding has a worth
  // of its own to store before it and a gain after it.
  test('a sweep-hidden holding sold inside the window is stored at its worth before the sale and its gain after', async () => {
    const f = await setupFixture({
      isHidden: true,
      hiddenBy: 'auto',
      readings: true,
      exit: 'sold-in-window',
    });
    await rollUp(f);

    const adHoc = await adHocUserFigures(f);
    expect(await storedUserFigures(f)).toEqual(adHoc);

    const own = async (daysAgo: number) => {
      const row = await holdingRowOn(f, f.closedHoldingId, daysAgo);
      return {
        totalValue: row?.totalValue,
        costBasis: row?.costBasis,
        realizedPnl: row?.realizedPnl,
        unrealizedPnl: row?.unrealizedPnl,
      };
    };
    // Day -7: ten units at that day's price of 125, bought at 100 each.
    expect(await own(7)).toEqual({
      totalValue: '1250',
      costBasis: '1000',
      realizedPnl: '0',
      unrealizedPnl: '250',
    });
    // Day -3: sold at 150 each, nothing left.
    expect(await own(3)).toEqual({
      totalValue: '0',
      costBasis: '0',
      realizedPnl: '500',
      unrealizedPnl: '0',
    });
  });

  // "Never priced and cooling down" is asked once per rollup, for the tokens
  // of the holdings it lists. A swept holding left off that list was counted
  // among the ones that ought to have had a price.
  test('a sweep-hidden holding of a token nobody can price is counted unpriceable, as ad hoc', async () => {
    const f = await setupFixture({
      isHidden: true,
      hiddenBy: 'auto',
      readings: false,
      exit: 'sold-in-window',
      unpriceable: true,
    });
    await rollUp(f);

    // Day -7, while it still holds its ten units: `kept` is the one holding a
    // price could be expected for, and it has one.
    const adHoc = await adHocUserFigures(f);
    expect(adHoc[7]?.holdingsUnpriceable).toBe(1);
    expect(adHoc[7]?.coverageQuality).toBe('full');
    expect(await storedUserFigures(f)).toEqual(adHoc);
    expect((await holdingRowOn(f, f.closedHoldingId, 7))?.holdingsUnpriceable).toBe(1);
  });

  test('control: the same unpriceable holding left visible is counted unpriceable, as ad hoc', async () => {
    const f = await setupFixture({
      isHidden: false,
      hiddenBy: null,
      readings: false,
      exit: 'sold-in-window',
      unpriceable: true,
    });
    await rollUp(f);

    const adHoc = await adHocUserFigures(f);
    expect(adHoc[7]?.holdingsUnpriceable).toBe(1);
    expect(adHoc[7]?.coverageQuality).toBe('full');
    expect(await storedUserFigures(f)).toEqual(adHoc);
    expect((await holdingRowOn(f, f.closedHoldingId, 7))?.holdingsUnpriceable).toBe(1);
  });

  // The coverage preload was as narrow as the ledger's, and here no reading
  // is involved: an import known to be truncated was graded a known cost.
  test('a sweep-hidden holding whose import was truncated is counted basis-unknown, as ad hoc', async () => {
    const f = await setupFixture({
      isHidden: true,
      hiddenBy: 'auto',
      readings: false,
      truncated: true,
    });
    await rollUp(f);

    const adHoc = await adHocUserFigures(f);
    expect(adHoc[0]?.holdingsBasisUnknown).toBe(1);
    expect(await storedUserFigures(f)).toEqual(adHoc);
  });

  // The home chart, the PnL series and both exports sum the per-holding rows
  // and never read the user row, so a holding with no row of its own is
  // missing from all of them whatever the user row says.
  test('the per-holding rows the chart sums carry the sweep-hidden holding', async () => {
    const f = await setupFixture({ isHidden: true, hiddenBy: 'auto', readings: true });
    await rollUp(f);

    expect(await holdingRows(f, f.closedHoldingId)).toHaveLength(LOOKBACK);

    const money = (v: string | null) => (v === null ? null : new Decimal(v).toString());
    const summed = await Container.get(
      PortfolioValueDailyRepository
    ).findIncludedHoldingDailyTotals(f.userId, f.usdId, DAYS.at(-1)!.at, RUN_START);
    const adHoc = await adHocUserFigures(f);
    expect(
      summed.map((day) => ({
        snapshotDate: day.snapshotDate,
        totalValue: money(day.totalValue),
        costBasis: money(day.costBasis),
        realizedPnl: money(day.realizedPnl),
        unrealizedPnl: money(day.unrealizedPnl),
        holdingsTotal: day.holdingsTotal,
      }))
    ).toEqual(
      [...adHoc].reverse().map((day) => ({
        snapshotDate: day.snapshotDate,
        totalValue: day.totalValue,
        costBasis: day.costBasis,
        realizedPnl: day.realizedPnl,
        unrealizedPnl: day.unrealizedPnl,
        holdingsTotal: day.holdingsTotal,
      }))
    );
  });

  test('control: an owner-hidden holding gets no row of its own, and a visible inactive one keeps its empty row', async () => {
    const f = await setupFixture({ isHidden: true, hiddenBy: 'user', readings: true });
    await rollUp(f);

    expect(await holdingRows(f, f.closedHoldingId)).toHaveLength(0);
    expect(await holdingRows(f, f.keptHoldingId)).toHaveLength(LOOKBACK);

    const dormant = await holdingRows(f, f.dormantHoldingId);
    expect(dormant).toHaveLength(LOOKBACK);
    expect(
      dormant.every(
        (r) => r.holdingsTotal === 0 && r.totalValue === '0' && r.coverageQuality === 'unknown'
      )
    ).toBe(true);
  });

  // `DriftLedgerService` memoises on the ledger map it is handed. A map
  // rebuilt per day would re-read every reading of every holding once per day.
  test('one rollup reads the ledger and the readings once, however many days it values', async () => {
    const f = await setupFixture({ isHidden: true, hiddenBy: 'auto', readings: true });
    const ledgerReads = spyOn(HoldingTransactionRepository.prototype, 'findForHoldingsAll');
    const readingReads = spyOn(
      HoldingBalanceObservationRepository.prototype,
      'findReadingsForHoldings'
    );
    try {
      const summary = await rollUp(f);
      expect(summary.daysComputed).toBe(LOOKBACK);
      expect(ledgerReads).toHaveBeenCalledTimes(1);
      expect(readingReads).toHaveBeenCalledTimes(1);
    } finally {
      ledgerReads.mockRestore();
      readingReads.mockRestore();
    }
  });
});
