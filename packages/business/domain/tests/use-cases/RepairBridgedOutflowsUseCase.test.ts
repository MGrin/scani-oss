/**
 * `RepairBridgedOutflowsUseCase` integration tests (SC-353).
 *
 * The fixture is the production shape exactly: one wallet on two chains, USDC
 * departing Ethereum into a bridge contract and arriving on Base four seconds
 * later a hundredth of a percent short — and the Base arrival already held by a
 * group that pairs it with the Base departure a minute afterwards, on the same
 * holding, answered by the user.
 *
 * Same isolation shape as `RepairMatchedOutflowsUseCase.test.ts` and for the
 * same reason: the use case and `TransferReviewService` both reach for the
 * global `db`, so `withTestDb`'s rollback cannot wrap them. A fresh user per
 * test scopes every query and `afterEach` cascades it away.
 *
 * What these assert in one sentence: **an arrival is claimed only when exactly
 * one cross-chain leg names itself, and withdrawing somebody's answer to get at
 * it takes a second authorisation that the code will not grant itself.**
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { RepairBridgedOutflowsUseCase } from '@scani/domain/use-cases/RepairBridgedOutflowsUseCase';
import { eq } from 'drizzle-orm';

const WALLET_ID = 'b7a11f2e-0000-4000-8000-000000000353';

interface Fixture {
  userId: string;
  /** USDC on Ethereum. */
  ethTokenId: string;
  /** USDC on Base — a different row, the same asset. */
  baseTokenId: string;
  ethHoldingId: string;
  baseHoldingId: string;
  institutionTypeId: string;
  institutionId: string;
  accountTypeId: string;
  tokenTypeId: string;
}

let fixture: Fixture | null = null;

function departedAt(): Date {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

function secondsLater(seconds: number): Date {
  return new Date(departedAt().getTime() + seconds * 1000);
}

async function setupFixture(): Promise<Fixture> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `br-${randomUUID().slice(0, 8)}@scani.local`, name: 'BridgedOutflowTest' })
    .returning();
  if (!user) throw new Error('user insert failed');

  const [instType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `br-${randomUUID().slice(0, 6)}`, name: 'BR Type' })
    .returning();
  if (!instType) throw new Error('instType insert failed');
  const [inst] = await db
    .insert(schema.institutions)
    .values({ name: `BR-${randomUUID().slice(0, 6)}`, typeId: instType.id })
    .returning();
  if (!inst) throw new Error('inst insert failed');
  const [acctType] = await db
    .insert(schema.accountTypes)
    .values({ code: `br-acct-${randomUUID().slice(0, 6)}`, name: 'BR Account' })
    .returning();
  if (!acctType) throw new Error('acctType insert failed');

  const account = async (name: string, chainId: string) => {
    const [row] = await db
      .insert(schema.accounts)
      .values({
        userId: user.id,
        institutionId: inst.id,
        typeId: acctType.id,
        name: `${name}-${randomUUID().slice(0, 6)}`,
        metadata: { chainId, userWalletId: WALLET_ID },
      })
      .returning();
    if (!row) throw new Error(`${name} account insert failed`);
    return row;
  };
  const ethAccount = await account('eth-0xb0b1', '1');
  const baseAccount = await account('base-0xb0b1', '8453');

  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `br-tok-${randomUUID().slice(0, 6)}`, name: 'BR Token Type' })
    .returning();
  if (!tokenType) throw new Error('tokenType insert failed');

  // Two token rows, ONE canonical asset. That difference is the whole of
  // `bridged_asset`: the same money on two chains is two rows here.
  const canonical = `usd-coin-${randomUUID().slice(0, 8)}`;
  const token = async (label: string) => {
    const [row] = await db
      .insert(schema.tokens)
      .values({
        symbol: `BR${randomUUID().toUpperCase().slice(0, 8)}`,
        name: `BR USDC ${label}`,
        typeId: tokenType.id,
        providerMetadata: { coingecko: { id: canonical } },
      })
      .returning();
    if (!row) throw new Error('token insert failed');
    return row;
  };
  const ethToken = await token('eth');
  const baseToken = await token('base');

  const holding = async (accountId: string, tokenId: string) => {
    const [row] = await db
      .insert(schema.holdings)
      .values({ userId: user.id, accountId, tokenId, balance: '0' })
      .returning();
    if (!row) throw new Error('holding insert failed');
    return row;
  };

  return {
    userId: user.id,
    ethTokenId: ethToken.id,
    baseTokenId: baseToken.id,
    ethHoldingId: (await holding(ethAccount.id, ethToken.id)).id,
    baseHoldingId: (await holding(baseAccount.id, baseToken.id)).id,
    institutionTypeId: instType.id,
    institutionId: inst.id,
    accountTypeId: acctType.id,
    tokenTypeId: tokenType.id,
  };
}

async function cleanupFixture(f: Fixture): Promise<void> {
  await db.delete(schema.users).where(eq(schema.users.id, f.userId));
  for (const id of [f.ethTokenId, f.baseTokenId]) {
    await db.delete(schema.tokens).where(eq(schema.tokens.id, id));
  }
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
  await db
    .delete(schema.institutionTypes)
    .where(eq(schema.institutionTypes.id, f.institutionTypeId));
}

/** A hash-shaped external id, so `upstreamEventKey` can read one event per leg. */
function hash(): string {
  return `0x${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
}

/** The Ethereum departure into the bridge, carrying the answer that realizes. */
async function insertDeparture(
  f: Fixture,
  opts: { quantity?: string; review?: string | null } = {}
): Promise<string> {
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: f.userId,
      holdingId: f.ethHoldingId,
      tokenId: f.ethTokenId,
      kind: 'transfer_out',
      quantity: opts.quantity ?? '-100',
      occurredAt: departedAt(),
      source: 'etherscan',
      externalId: `${hash()}-0xa0b86991`,
      rawPayload: { to: '0x3a23f943181408eac424116af7b7790c94cb97a5' },
      transferReviewedAt: new Date(),
      ...(opts.review === undefined
        ? { transferReview: 'left_control' }
        : opts.review === null
          ? { transferReviewedAt: null }
          : { transferReview: opts.review }),
    })
    .returning();
  if (!row) throw new Error('departure insert failed');
  return row.id;
}

/** The Base arrival the bridge produced. */
async function insertArrival(
  f: Fixture,
  opts: { quantity?: string; seconds?: number; transferGroupId?: string } = {}
): Promise<string> {
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: f.userId,
      holdingId: f.baseHoldingId,
      tokenId: f.baseTokenId,
      kind: 'transfer_in',
      quantity: opts.quantity ?? '99.987122',
      occurredAt: secondsLater(opts.seconds ?? 4),
      source: 'etherscan',
      externalId: `${hash()}-0x833589fc`,
      rawPayload: { to: '0xb0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9' },
      ...(opts.transferGroupId ? { transferGroupId: opts.transferGroupId } : {}),
    })
    .returning();
  if (!row) throw new Error('arrival insert failed');
  return row.id;
}

/**
 * The Base departure that follows the arrival about a minute later and, in
 * production, was answered `paired` WITH it — two legs on one holding.
 */
async function insertSameHoldingPartner(
  f: Fixture,
  opts: { transferGroupId: string; review?: string | null; seconds?: number }
): Promise<string> {
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: f.userId,
      holdingId: f.baseHoldingId,
      tokenId: f.baseTokenId,
      kind: 'transfer_out',
      quantity: '-100',
      occurredAt: secondsLater(opts.seconds ?? 106),
      source: 'etherscan',
      externalId: `${hash()}-0x833589fc`,
      rawPayload: { to: '0x5c918000000000000000000000000000000000b2' },
      transferGroupId: opts.transferGroupId,
      ...(opts.review === null
        ? {}
        : {
            transferReview: opts.review ?? 'paired',
            transferReviewedAt: new Date(),
            transferReviewSource: 'user',
          }),
    })
    .returning();
  if (!row) throw new Error('partner insert failed');
  return row.id;
}

function useCase(): RepairBridgedOutflowsUseCase {
  return new RepairBridgedOutflowsUseCase();
}

beforeEach(async () => {
  fixture = await setupFixture();
});

afterEach(async () => {
  if (fixture) await cleanupFixture(fixture);
  fixture = null;
});

describe('RepairBridgedOutflowsUseCase — deriving the decision', () => {
  test('derives `bridged` for a single cross-chain arrival, and reports no blocker', async () => {
    const f = fixture!;
    const departure = await insertDeparture(f);
    const arrival = await insertArrival(f);

    const plans = await useCase().plansFor(f.userId);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.transactionId).toBe(departure);
    expect(plans[0]?.action).toBe('bridged');
    expect(plans[0]?.arrival?.transactionId).toBe(arrival);
    expect(plans[0]?.arrival?.gapSeconds).toBe(4);
    expect(plans[0]?.arrival?.deltaPct).toBe('-0.0129');
    expect(plans[0]?.blocker).toBeNull();
    /**
     * The provenance carried to the reader — and this fixture is the exact
     * production shape SC-673 is about: a review timestamp with NO source, the
     * state 27 of mgrin's `left_control` rows are in.
     *
     * It asserted `'user'` until SC-673, which is the defect: the departure
     * fixture sets `transferReviewedAt` and no source, and the decoder read the
     * date as the reader's own answer. Note `insertSameHoldingPartner` below
     * DOES set `transferReviewSource: 'user'` — the two fixtures disagreed, and
     * only the one that named a source was saying what it meant.
     *
     * Left as-is rather than given a source, because a DB-backed assertion on
     * the unsourced shape is coverage this fix otherwise has nowhere.
     */
    expect(plans[0]?.answerSource).toBe('unattributed');
  });

  test('reports the blocking group instead of dropping the row, when the arrival is claimed', async () => {
    const f = fixture!;
    const groupId = randomUUID();
    const departure = await insertDeparture(f);
    const arrival = await insertArrival(f, { transferGroupId: groupId });
    const partner = await insertSameHoldingPartner(f, { transferGroupId: groupId });

    const plans = await useCase().plansFor(f.userId);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.transactionId).toBe(departure);
    expect(plans[0]?.action).toBe('bridged');
    expect(plans[0]?.arrival?.transactionId).toBe(arrival);
    expect(plans[0]?.blocker?.groupId).toBe(groupId);
    expect(plans[0]?.blocker?.verdict.unlink).toBe(true);
    expect(plans[0]?.blocker?.legs).toHaveLength(2);
    expect(plans[0]?.blocker?.answeredLegs.map((l) => l.transactionId)).toEqual([partner]);
    expect(plans[0]?.blocker?.answeredLegs[0]?.answerSource).toBe('user');
  });

  test('blocks when the claiming group is ONE upstream event — never re-mints a real no-op', async () => {
    const f = fixture!;
    const groupId = randomUUID();
    await insertDeparture(f);
    const arrival = await insertArrival(f, { transferGroupId: groupId });
    // The partner shares the arrival's transaction hash: one event touching the
    // wallet twice, whose group id is load-bearing (SC-344/SC-347).
    const [arrivalRow] = await db
      .select({ externalId: schema.holdingTransactions.externalId })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, arrival));
    await db.insert(schema.holdingTransactions).values({
      userId: f.userId,
      holdingId: f.baseHoldingId,
      tokenId: f.baseTokenId,
      kind: 'transfer_out',
      quantity: '-99.987122',
      occurredAt: secondsLater(4),
      source: 'etherscan',
      externalId: `${arrivalRow?.externalId?.split('-')[0]}-0x00000000`,
      transferGroupId: groupId,
    });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('blocked');
    expect(plans[0]?.blockedReason).toContain('one upstream event');
    // Still reported, because a refusal the reader cannot see the shape of is
    // indistinguishable from the row not existing.
    expect(plans[0]?.arrival?.transactionId).toBe(arrival);
  });

  test('ignores a same-token arrival — that population belongs to SC-328', async () => {
    const f = fixture!;
    await insertDeparture(f);
    // Same TOKEN row as the departure, on the Base holding. `candidatePairClass`
    // calls this `same_token`, and this use case must not see it at all.
    await db.insert(schema.holdingTransactions).values({
      userId: f.userId,
      holdingId: f.baseHoldingId,
      tokenId: f.ethTokenId,
      kind: 'transfer_in',
      quantity: '99.987122',
      occurredAt: secondsLater(4),
      source: 'etherscan',
      externalId: `${hash()}-0x833589fc`,
    });

    expect(await useCase().plansFor(f.userId)).toHaveLength(0);
  });

  test('blocks when two ACTIONABLE cross-chain arrivals could each be the money', async () => {
    const f = fixture!;
    await insertDeparture(f);
    await insertArrival(f, { seconds: 4 });
    await insertArrival(f, { seconds: 40, quantity: '99.99' });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('blocked');
    expect(plans[0]?.blockedReason).toContain('2 cross-chain arrivals inside');
    expect(plans[0]?.candidateCount).toBe(2);
  });

  test('a near miss in the WIDE net does not veto a decision the deciding bounds settle', async () => {
    const f = fixture!;
    // The production contradiction: a second arrival over an hour out — outside
    // the 30-minute window, and in production the arrival that a DIFFERENT
    // departure claims seconds after leaving. Showing it is the
    // wide net's job; vetoing with it is not.
    const departure = await insertDeparture(f);
    const arrival = await insertArrival(f, { seconds: 6 });
    await insertArrival(f, { seconds: 73 * 60, quantity: '99.987175' });

    const plans = await useCase().plansFor(f.userId);
    const plan = plans.find((p) => p.transactionId === departure);
    expect(plan?.action).toBe('bridged');
    expect(plan?.arrival?.transactionId).toBe(arrival);
    // Still counted, so the reader sees what was looked at and set aside.
    expect(plan?.candidateCount).toBe(2);
  });

  test('blocks an arrival further out than the percentage bound a bridge fee fits', async () => {
    const f = fixture!;
    await insertDeparture(f, { quantity: '-100' });
    await insertArrival(f, { quantity: '97' });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('blocked');
    expect(plans[0]?.blockedReason).toContain('outside the 2% bound');
    expect(plans[0]?.blockedReason).toContain('none actionable');
  });

  test('ignores an outflow that is not answered `left_control`', async () => {
    const f = fixture!;
    await insertDeparture(f, { review: 'untracked' });
    await insertArrival(f);

    expect(await useCase().plansFor(f.userId)).toHaveLength(0);
  });
});

describe('RepairBridgedOutflowsUseCase — applying', () => {
  test('pairs the bridge and stamps `repair` when nothing has to be withdrawn', async () => {
    const f = fixture!;
    const departure = await insertDeparture(f);
    const arrival = await insertArrival(f);

    const [plan] = await useCase().plansFor(f.userId);
    if (!plan) throw new Error('no plan derived');
    await useCase().apply(plan);

    const rows = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    const out = rows.find((r) => r.id === departure);
    const inn = rows.find((r) => r.id === arrival);
    expect(out?.transferReview).toBe('paired');
    expect(out?.transferReviewSource).toBe('repair');
    expect(out?.transferGroupId).not.toBeNull();
    expect(inn?.transferGroupId).toBe(out?.transferGroupId ?? '');
  });

  test('REFUSES to withdraw somebody’s answer without the second authorisation', async () => {
    const f = fixture!;
    const groupId = randomUUID();
    await insertDeparture(f);
    await insertArrival(f, { transferGroupId: groupId });
    const partner = await insertSameHoldingPartner(f, { transferGroupId: groupId });

    const [plan] = await useCase().plansFor(f.userId);
    if (!plan) throw new Error('no plan derived');
    await expect(useCase().apply(plan)).rejects.toThrow('allowReopeningAnswers');

    const [row] = await db
      .select({ review: schema.holdingTransactions.transferReview })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, partner));
    expect(row?.review).toBe('paired');
  });

  test('with the authorisation: frees the arrival, pairs the bridge, leaves the freed leg UNANSWERED', async () => {
    const f = fixture!;
    const groupId = randomUUID();
    const departure = await insertDeparture(f);
    const arrival = await insertArrival(f, { transferGroupId: groupId });
    const partner = await insertSameHoldingPartner(f, { transferGroupId: groupId });

    const [plan] = await useCase().plansFor(f.userId);
    if (!plan) throw new Error('no plan derived');
    await useCase().apply(plan, { allowReopeningAnswers: true });

    const rows = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    const out = rows.find((r) => r.id === departure);
    const inn = rows.find((r) => r.id === arrival);
    const freed = rows.find((r) => r.id === partner);

    expect(out?.transferReview).toBe('paired');
    expect(out?.transferReviewSource).toBe('repair');
    expect(inn?.transferGroupId).toBe(out?.transferGroupId ?? '');
    // The freed departure asks a question rather than answering one: an
    // unanswered outflow with no group books nothing (`hold`).
    expect(freed?.transferReview).toBeNull();
    expect(freed?.transferGroupId).toBeNull();
    expect(freed?.transferReviewSource).toBeNull();
    // And nothing was invented to stand in for the arrival.
    expect(rows.filter((r) => r.source === 'transfer-review')).toHaveLength(0);
  });

  test('refuses to apply a blocked plan', async () => {
    const f = fixture!;
    await insertDeparture(f, { quantity: '-100' });
    await insertArrival(f, { quantity: '97' });

    const [plan] = await useCase().plansFor(f.userId);
    if (!plan) throw new Error('no plan derived');
    await expect(useCase().apply(plan, { allowReopeningAnswers: true })).rejects.toThrow(
      'refusing to apply a blocked plan'
    );
  });
});
