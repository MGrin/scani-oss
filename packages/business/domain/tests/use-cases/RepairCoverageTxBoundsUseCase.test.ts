/**
 * `RepairCoverageTxBoundsUseCase` integration tests (SC-319).
 *
 * The fixture is the production shape, because that is the only shape in which
 * the decision is interesting: two holdings imported by one run, one of them
 * old and one bought last week, both stamped with the RUN's oldest and newest
 * event (SC-308). The old holding's row is therefore CORRECT by accident and
 * the young one's is wrong — so a repair that keys off "was this run-stamped?"
 * would touch both, and one that keys off the evidence touches one.
 *
 * Same isolation shape as `RepairOwnWalletDisposalsUseCase.test.ts` and for the
 * same reason: the use case reaches for the global `db`, so `withTestDb`'s
 * rollback cannot wrap it. A fresh user per test scopes every query and
 * `afterEach` cascades it away.
 *
 * What these assert, in one sentence: **the bounds are re-derived from each
 * holding's OWN ledger, and no coverage row is ever brought into existence** —
 * `CostBasisService` reads an absent row as `'unrecorded'` and a present
 * `false` one as `'incomplete'`, so inserting is a different claim, not a
 * wider repair.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { RepairCoverageTxBoundsUseCase } from '../../src/use-cases/RepairCoverageTxBoundsUseCase';

/** The run's oldest event — the BTC buy, on the holding held since 2021. */
const RUN_FIRST = new Date('2021-09-17T06:54:48.401Z');
/** The run's newest event — a reward booked on a third holding entirely. */
const RUN_LAST = new Date('2026-05-11T07:56:37.445Z');
/** The young holding's own ledger: one buy, one sell, six days apart. */
const YOUNG_FIRST = new Date('2026-07-14T15:31:53.992Z');
const YOUNG_LAST = new Date('2026-07-20T15:31:54.000Z');

interface Fixture {
  userId: string;
  oldTokenId: string;
  youngTokenId: string;
  /** Held since 2021 — its own bounds happen to equal the run's start. */
  oldHoldingId: string;
  /** Bought last week — stamped with the run's bounds, and wrong. */
  youngHoldingId: string;
  /** Has a ledger and NO coverage row. Nothing may create one. */
  uncoveredHoldingId: string;
  accountId: string;
  institutionTypeId: string;
  institutionId: string;
  accountTypeId: string;
  tokenTypeId: string;
}

let fixture: Fixture | null = null;

async function setupFixture(): Promise<Fixture> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `cov-${randomUUID().slice(0, 8)}@scani.local`, name: 'CoverageTest' })
    .returning();
  if (!user) throw new Error('user insert failed');

  const [instType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `cov-${randomUUID().slice(0, 6)}`, name: 'Cov Type' })
    .returning();
  if (!instType) throw new Error('instType insert failed');
  const [inst] = await db
    .insert(schema.institutions)
    .values({ name: `Cov-${randomUUID().slice(0, 6)}`, typeId: instType.id })
    .returning();
  if (!inst) throw new Error('inst insert failed');
  const [acctType] = await db
    .insert(schema.accountTypes)
    .values({ code: `cov-acct-${randomUUID().slice(0, 6)}`, name: 'Cov Account' })
    .returning();
  if (!acctType) throw new Error('acctType insert failed');
  const [account] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: inst.id,
      typeId: acctType.id,
      name: `Main-${randomUUID().slice(0, 6)}`,
    })
    .returning();
  if (!account) throw new Error('account insert failed');

  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `cov-tok-${randomUUID().slice(0, 6)}`, name: 'Cov Token Type' })
    .returning();
  if (!tokenType) throw new Error('tokenType insert failed');
  const token = async (symbol: string) => {
    const [row] = await db
      .insert(schema.tokens)
      .values({
        symbol: `${symbol}${randomUUID().slice(0, 6).toUpperCase()}`,
        name: symbol,
        typeId: tokenType.id,
      })
      .returning();
    if (!row) throw new Error('token insert failed');
    return row;
  };
  const oldToken = await token('OLD');
  const youngToken = await token('YNG');

  const holding = async (tokenId: string) => {
    const [row] = await db
      .insert(schema.holdings)
      .values({ userId: user.id, accountId: account.id, tokenId, balance: '1' })
      .returning();
    if (!row) throw new Error('holding insert failed');
    return row;
  };
  const oldHolding = await holding(oldToken.id);
  const youngHolding = await holding(youngToken.id);
  const uncoveredHolding = await holding(youngToken.id);

  return {
    userId: user.id,
    oldTokenId: oldToken.id,
    youngTokenId: youngToken.id,
    oldHoldingId: oldHolding.id,
    youngHoldingId: youngHolding.id,
    uncoveredHoldingId: uncoveredHolding.id,
    accountId: account.id,
    institutionTypeId: instType.id,
    institutionId: inst.id,
    accountTypeId: acctType.id,
    tokenTypeId: tokenType.id,
  };
}

async function cleanupFixture(f: Fixture): Promise<void> {
  await db.delete(schema.users).where(eq(schema.users.id, f.userId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, f.oldTokenId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, f.youngTokenId));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
  await db
    .delete(schema.institutionTypes)
    .where(eq(schema.institutionTypes.id, f.institutionTypeId));
}

async function insertTx(
  f: Fixture,
  holdingId: string,
  tokenId: string,
  occurredAt: Date
): Promise<void> {
  await db.insert(schema.holdingTransactions).values({
    userId: f.userId,
    holdingId,
    tokenId,
    kind: 'buy',
    quantity: '1',
    occurredAt,
    source: 'kraken-api',
    externalId: `cov-${randomUUID().slice(0, 12)}`,
  });
}

/** Coverage exactly as SC-308 left it: the RUN's bounds, on every holding. */
async function stampRunBounds(holdingId: string, complete: boolean): Promise<void> {
  await db.insert(schema.holdingCoverage).values({
    holdingId,
    firstTxAt: RUN_FIRST,
    lastTxAt: RUN_LAST,
    txSources: ['kraken-api'],
    hasCompleteTxHistory: complete,
  });
}

const useCase = (): RepairCoverageTxBoundsUseCase => new RepairCoverageTxBoundsUseCase();

describe('RepairCoverageTxBoundsUseCase', () => {
  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(async () => {
    if (fixture) await cleanupFixture(fixture);
    fixture = null;
  });

  test("plans the holding whose stored bounds are the run's, not its own", async () => {
    const f = fixture as Fixture;
    await insertTx(f, f.oldHoldingId, f.oldTokenId, RUN_FIRST);
    await insertTx(f, f.youngHoldingId, f.youngTokenId, YOUNG_FIRST);
    await insertTx(f, f.youngHoldingId, f.youngTokenId, YOUNG_LAST);
    await stampRunBounds(f.oldHoldingId, true);
    await stampRunBounds(f.youngHoldingId, false);

    const plans = await useCase().plansFor(f.userId);

    // Both rows carry the run's stamp; only one of them is WRONG about its own
    // ledger, and the old holding's `last_tx_at` is wrong while its
    // `first_tx_at` is right — so it is planned too, for the end alone.
    const young = plans.find((p) => p.holdingId === f.youngHoldingId);
    expect(young).toBeDefined();
    expect(young?.storedFirstTxAt?.toISOString()).toBe(RUN_FIRST.toISOString());
    expect(young?.ledgerFirstTxAt?.toISOString()).toBe(YOUNG_FIRST.toISOString());
    expect(young?.txCount).toBe(2);
    // 2021-09-17 -> 2026-07-14 is 1761 whole days of invented history.
    expect(young?.firstEarlyDays).toBe(1761);
  });

  test('does not plan a row whose bounds already match its ledger', async () => {
    const f = fixture as Fixture;
    await insertTx(f, f.youngHoldingId, f.youngTokenId, YOUNG_FIRST);
    await db.insert(schema.holdingCoverage).values({
      holdingId: f.youngHoldingId,
      firstTxAt: YOUNG_FIRST,
      lastTxAt: YOUNG_FIRST,
      txSources: ['kraken-api'],
      hasCompleteTxHistory: true,
    });

    const plans = await useCase().plansFor(f.userId);

    expect(plans.map((p) => p.holdingId)).not.toContain(f.youngHoldingId);
  });

  test('never plans, and never creates, a coverage row for a holding that has none', async () => {
    const f = fixture as Fixture;
    await insertTx(f, f.uncoveredHoldingId, f.youngTokenId, YOUNG_FIRST);
    await insertTx(f, f.youngHoldingId, f.youngTokenId, YOUNG_FIRST);
    await stampRunBounds(f.youngHoldingId, false);

    const repair = useCase();
    const plans = await repair.plansFor(f.userId);
    expect(plans.map((p) => p.holdingId)).not.toContain(f.uncoveredHoldingId);

    for (const plan of plans) await repair.apply(plan);

    const rows = await db
      .select({ holdingId: schema.holdingCoverage.holdingId })
      .from(schema.holdingCoverage)
      .where(eq(schema.holdingCoverage.holdingId, f.uncoveredHoldingId));
    // An absent row is `'unrecorded'`; a created one would be `'incomplete'`.
    expect(rows).toHaveLength(0);
  });

  test("apply re-derives from the holding's own ledger and leaves the plan empty", async () => {
    const f = fixture as Fixture;
    await insertTx(f, f.youngHoldingId, f.youngTokenId, YOUNG_FIRST);
    await insertTx(f, f.youngHoldingId, f.youngTokenId, YOUNG_LAST);
    await stampRunBounds(f.youngHoldingId, false);

    const repair = useCase();
    const plans = await repair.plansFor(f.userId);
    for (const plan of plans) await repair.apply(plan);

    const [row] = await db
      .select()
      .from(schema.holdingCoverage)
      .where(eq(schema.holdingCoverage.holdingId, f.youngHoldingId));
    expect(row?.firstTxAt?.toISOString()).toBe(YOUNG_FIRST.toISOString());
    expect(row?.lastTxAt?.toISOString()).toBe(YOUNG_LAST.toISOString());
    expect(await repair.verify([f.youngHoldingId])).toHaveLength(0);
  });

  test('apply leaves has_complete_tx_history and tx_sources alone', async () => {
    const f = fixture as Fixture;
    await insertTx(f, f.youngHoldingId, f.youngTokenId, YOUNG_FIRST);
    await stampRunBounds(f.youngHoldingId, true);

    const repair = useCase();
    for (const plan of await repair.plansFor(f.userId)) await repair.apply(plan);

    const [row] = await db
      .select()
      .from(schema.holdingCoverage)
      .where(eq(schema.holdingCoverage.holdingId, f.youngHoldingId));
    // The claim about completeness belongs to the import that made it. This
    // repair is about the bounds and may not restate it (SC-149).
    expect(row?.hasCompleteTxHistory).toBe(true);
    expect(row?.txSources).toEqual(['kraken-api']);
  });

  test('is idempotent — a second run derives nothing', async () => {
    const f = fixture as Fixture;
    await insertTx(f, f.youngHoldingId, f.youngTokenId, YOUNG_FIRST);
    await stampRunBounds(f.youngHoldingId, false);

    const repair = useCase();
    for (const plan of await repair.plansFor(f.userId)) await repair.apply(plan);
    const second = await repair.plansFor(f.userId);

    expect(second.map((p) => p.holdingId)).not.toContain(f.youngHoldingId);
  });
});
