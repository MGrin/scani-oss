/**
 * `RetractKrakenCoverageClaimsUseCase` integration tests (SC-395).
 *
 * The fixture is a Kraken account with two holdings claiming a complete
 * history and a stored ledger that either does or does not contradict them —
 * because the interesting decision is not "retract" but "when NOT to". A
 * repair that keyed off "this row says complete and the source is Kraken"
 * would move all 45 of production's complete-coverage rows; one that keys off
 * the evidence moves the 2 whose ledger disagrees with them.
 *
 * Same isolation shape as `RepairCoverageTxBoundsUseCase.test.ts` and for the
 * same reason: the use case reaches for the global `db`, so `withTestDb`'s
 * rollback cannot wrap it. A fresh user per test scopes every query and
 * `afterEach` cascades it away.
 *
 * The audit itself is `auditKrakenLedger`, the same pure function the live
 * paginator runs — over `raw_payload`, which the Kraken importer stores
 * verbatim. There is no second implementation of "does this feed contradict
 * itself" for the two to drift apart on.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { RetractKrakenCoverageClaimsUseCase } from '../../src/use-cases/RetractKrakenCoverageClaimsUseCase';

interface Fixture {
  userId: string;
  accountId: string;
  btcTokenId: string;
  usdTokenId: string;
  btcHoldingId: string;
  usdHoldingId: string;
  institutionTypeId: string;
  institutionId: string;
  accountTypeId: string;
  tokenTypeId: string;
}

let fixture: Fixture | null = null;

async function setupFixture(): Promise<Fixture> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `krk-${randomUUID().slice(0, 8)}@scani.local`, name: 'KrakenCoverageTest' })
    .returning();
  if (!user) throw new Error('user insert failed');

  const [instType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `krk-${randomUUID().slice(0, 6)}`, name: 'Krk Type' })
    .returning();
  if (!instType) throw new Error('instType insert failed');
  const [inst] = await db
    .insert(schema.institutions)
    .values({ name: `Krk-${randomUUID().slice(0, 6)}`, typeId: instType.id })
    .returning();
  if (!inst) throw new Error('inst insert failed');
  const [acctType] = await db
    .insert(schema.accountTypes)
    .values({ code: `krk-acct-${randomUUID().slice(0, 6)}`, name: 'Krk Account' })
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
    .values({ code: `krk-tok-${randomUUID().slice(0, 6)}`, name: 'Krk Token Type' })
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
  const btcToken = await token('BTC');
  const usdToken = await token('USD');

  const holding = async (tokenId: string) => {
    const [row] = await db
      .insert(schema.holdings)
      .values({ userId: user.id, accountId: account.id, tokenId, balance: '1' })
      .returning();
    if (!row) throw new Error('holding insert failed');
    return row;
  };
  const btcHolding = await holding(btcToken.id);
  const usdHolding = await holding(usdToken.id);

  return {
    userId: user.id,
    accountId: account.id,
    btcTokenId: btcToken.id,
    usdTokenId: usdToken.id,
    btcHoldingId: btcHolding.id,
    usdHoldingId: usdHolding.id,
    institutionTypeId: instType.id,
    institutionId: inst.id,
    accountTypeId: acctType.id,
    tokenTypeId: tokenType.id,
  };
}

async function cleanupFixture(f: Fixture): Promise<void> {
  await db.delete(schema.users).where(eq(schema.users.id, f.userId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, f.btcTokenId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, f.usdTokenId));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
  await db
    .delete(schema.institutionTypes)
    .where(eq(schema.institutionTypes.id, f.institutionTypeId));
}

/** A Kraken ledger entry as `/private/Ledgers` states it, stored verbatim. */
function entry(over: Record<string, unknown>): Record<string, unknown> {
  return {
    refid: 'REF-1',
    time: 1_700_000_000,
    type: 'spend',
    aclass: 'currency',
    asset: 'XXBT',
    amount: '-1.0000',
    fee: '0.0000',
    balance: '0.0000',
    ...over,
  };
}

async function insertLedgerRow(
  f: Fixture,
  holdingId: string,
  tokenId: string,
  payload: Record<string, unknown> | null
): Promise<void> {
  await db.insert(schema.holdingTransactions).values({
    userId: f.userId,
    holdingId,
    tokenId,
    kind: 'sell',
    quantity: '-1',
    occurredAt: new Date(Number(payload?.time ?? 1_700_000_000) * 1000),
    source: 'kraken-api',
    externalId: `krk-${randomUUID().slice(0, 12)}`,
    rawPayload: payload,
  });
}

async function claimComplete(holdingId: string, complete: boolean): Promise<void> {
  await db.insert(schema.holdingCoverage).values({
    holdingId,
    firstTxAt: null,
    lastTxAt: null,
    txSources: ['kraken-api'],
    hasCompleteTxHistory: complete,
  });
}

const useCase = (): RetractKrakenCoverageClaimsUseCase => new RetractKrakenCoverageClaimsUseCase();

/** A convert whose `receive` leg never arrived — SC-392's production shape. */
async function seedContradictoryLedger(f: Fixture): Promise<void> {
  await insertLedgerRow(
    f,
    f.btcHoldingId,
    f.btcTokenId,
    entry({ refid: 'TS6JBSQ-MTBTI-4B3RF7', type: 'spend', amount: '-0.0539', balance: '0.0000' })
  );
}

/** The same operation with both legs, so the feed says nothing is missing. */
async function seedConsistentLedger(f: Fixture): Promise<void> {
  await insertLedgerRow(
    f,
    f.btcHoldingId,
    f.btcTokenId,
    entry({ refid: 'T1', type: 'spend', asset: 'XXBT', amount: '-1.0000', balance: '0.0000' })
  );
  await insertLedgerRow(
    f,
    f.usdHoldingId,
    f.usdTokenId,
    entry({
      refid: 'T1',
      type: 'receive',
      asset: 'ZUSD',
      amount: '3000.0000',
      balance: '3000.0000',
    })
  );
}

describe('RetractKrakenCoverageClaimsUseCase', () => {
  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(async () => {
    if (fixture) await cleanupFixture(fixture);
    fixture = null;
  });

  test('plans the account whose stored ledger contradicts its claim', async () => {
    const f = fixture as Fixture;
    await seedContradictoryLedger(f);
    await claimComplete(f.btcHoldingId, true);
    await claimComplete(f.usdHoldingId, true);

    const { plans, blocked } = await useCase().audit(f.userId);

    expect(blocked).toEqual([]);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.accountId).toBe(f.accountId);
    expect(plans[0]?.unpairedOperations).toBe(1);
    expect(plans[0]?.entriesAudited).toBe(1);
    // Both claiming holdings move, because the verdict is about the FEED the
    // account was walked from and not about one token's rows within it.
    expect(new Set(plans[0]?.claimingHoldings.map((h) => h.holdingId))).toEqual(
      new Set([f.btcHoldingId, f.usdHoldingId])
    );
  });

  // THE NEGATIVE CONTROL. Without it, a repair that retracts every Kraken
  // claim it finds passes every other test in this file — and takes the cost
  // basis of every correctly-claimed holding down with it.
  test('a self-consistent ledger is left claiming a complete history', async () => {
    const f = fixture as Fixture;
    await seedConsistentLedger(f);
    await claimComplete(f.btcHoldingId, true);
    await claimComplete(f.usdHoldingId, true);

    const { plans, blocked } = await useCase().audit(f.userId);

    expect(plans).toEqual([]);
    expect(blocked).toEqual([]);
  });

  test('a claim with no stored Kraken rows is BLOCKED, never repaired', async () => {
    const f = fixture as Fixture;
    await claimComplete(f.btcHoldingId, true);

    const { plans, blocked } = await useCase().audit(f.userId);

    expect(plans).toEqual([]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.reason).toContain('stores no Kraken ledger rows');
  });

  test('a payload missing a field the audit reads is BLOCKED, never repaired', async () => {
    const f = fixture as Fixture;
    // No `balance`: the running-balance chain cannot be checked, and a
    // `Decimal(undefined)` would throw rather than answer. Silence is not
    // agreement (SC-403).
    const { balance: _dropped, ...withoutBalance } = entry({});
    await insertLedgerRow(f, f.btcHoldingId, f.btcTokenId, withoutBalance);
    await claimComplete(f.btcHoldingId, true);

    const { plans, blocked } = await useCase().audit(f.userId);

    expect(plans).toEqual([]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.reason).toContain('missing a field the audit reads');
  });

  test('a holding whose coverage already reads false is not a claim to retract', async () => {
    const f = fixture as Fixture;
    await seedContradictoryLedger(f);
    await claimComplete(f.btcHoldingId, true);
    await claimComplete(f.usdHoldingId, false);

    const { plans } = await useCase().audit(f.userId);

    expect(plans[0]?.claimingHoldings.map((h) => h.holdingId)).toEqual([f.btcHoldingId]);
  });

  test('apply retracts the account claim and verify reads the table back', async () => {
    const f = fixture as Fixture;
    await seedContradictoryLedger(f);
    await claimComplete(f.btcHoldingId, true);
    await claimComplete(f.usdHoldingId, true);
    const repair = useCase();
    const { plans } = await repair.audit(f.userId);
    const plan = plans[0];
    if (!plan) throw new Error('expected a plan');

    const moved = await repair.apply(plan);

    expect(moved).toBe(2);
    const after = await repair.verify([f.btcHoldingId, f.usdHoldingId]);
    expect(after.every((row) => row.hasCompleteTxHistory === false)).toBe(true);
    // Re-auditing finds nothing left to do: the claim it contradicted is gone.
    expect((await repair.audit(f.userId)).plans).toEqual([]);
  });

  test('the repair never brings a coverage row into existence', async () => {
    const f = fixture as Fixture;
    await seedContradictoryLedger(f);
    await claimComplete(f.btcHoldingId, true);
    // `usdHolding` has NO coverage row. An absent row reads as 'unrecorded'
    // and a created `false` one would read as 'incomplete' — a different
    // claim about a holding nobody imported, not a wider repair (SC-319).
    const repair = useCase();
    const { plans } = await repair.audit(f.userId);
    const plan = plans[0];
    if (!plan) throw new Error('expected a plan');

    await repair.apply(plan);

    const rows = await db
      .select({ holdingId: schema.holdingCoverage.holdingId })
      .from(schema.holdingCoverage)
      .where(eq(schema.holdingCoverage.holdingId, f.usdHoldingId));
    expect(rows).toEqual([]);
  });
});
