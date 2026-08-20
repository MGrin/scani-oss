/**
 * `RepairMatchedOutflowsUseCase` integration tests (SC-328).
 *
 * The fixture is the production shape: an ETH departure from a wallet, and the
 * exchange deposit it became four minutes later on another holding — the case
 * SC-302's destination test could not see, because a deposit forwarder is not
 * in `user_wallets` and reads as a stranger.
 *
 * Same isolation shape as `RepairOwnWalletDisposalsUseCase.test.ts` and for the
 * same reason: the use case and `TransferReviewService` both reach for the
 * global `db`, so `withTestDb`'s rollback cannot wrap them. A fresh user per
 * test scopes every query and `afterEach` cascades it away.
 *
 * What these assert in one sentence: **an arrival is claimed only when the
 * ledger names exactly one, and every other shape is a refusal rather than a
 * guess.** Claiming the wrong arrival merges two lot chains and moves cost
 * basis across a boundary it never crossed, which is worse than the wrong
 * answer being corrected.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { RepairMatchedOutflowsUseCase } from '@scani/domain/use-cases/RepairMatchedOutflowsUseCase';
import { eq } from 'drizzle-orm';

const WALLET = '0x01583d152e3225519d211b1f576d959f70ef9630';

interface Fixture {
  userId: string;
  tokenId: string;
  /** Where the money left from. */
  outHoldingId: string;
  /** Where it landed — the exchange. */
  inHoldingId: string;
  institutionTypeId: string;
  institutionId: string;
  accountTypeId: string;
  tokenTypeId: string;
}

let fixture: Fixture | null = null;

/** Departure time. Fixed relative to now so nothing depends on the clock. */
function departedAt(): Date {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

function minutesLater(minutes: number): Date {
  return new Date(departedAt().getTime() + minutes * 60 * 1000);
}

async function setupFixture(): Promise<Fixture> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `mo-${randomUUID().slice(0, 8)}@scani.local`, name: 'MatchedOutflowTest' })
    .returning();
  if (!user) throw new Error('user insert failed');

  const [instType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `mo-${randomUUID().slice(0, 6)}`, name: 'MO Type' })
    .returning();
  if (!instType) throw new Error('instType insert failed');
  const [inst] = await db
    .insert(schema.institutions)
    .values({ name: `MO-${randomUUID().slice(0, 6)}`, typeId: instType.id })
    .returning();
  if (!inst) throw new Error('inst insert failed');
  const [acctType] = await db
    .insert(schema.accountTypes)
    .values({ code: `mo-acct-${randomUUID().slice(0, 6)}`, name: 'MO Account' })
    .returning();
  if (!acctType) throw new Error('acctType insert failed');

  const account = async (name: string, metadata: Record<string, unknown> | null) => {
    const [row] = await db
      .insert(schema.accounts)
      .values({
        userId: user.id,
        institutionId: inst.id,
        typeId: acctType.id,
        name: `${name}-${randomUUID().slice(0, 6)}`,
        ...(metadata ? { metadata } : {}),
      })
      .returning();
    if (!row) throw new Error(`${name} account insert failed`);
    return row;
  };
  const walletAccount = await account('eth-0158', { chainId: '1', walletAddress: WALLET });
  // No chain and no wallet: an exchange, which is what the arrival lands on.
  const exchangeAccount = await account('kraken-main', null);

  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `mo-tok-${randomUUID().slice(0, 6)}`, name: 'MO Token Type' })
    .returning();
  if (!tokenType) throw new Error('tokenType insert failed');
  const [token] = await db
    .insert(schema.tokens)
    .values({ symbol: `MO${randomUUID().toUpperCase()}`, name: 'MO Ether', typeId: tokenType.id })
    .returning();
  if (!token) throw new Error('token insert failed');

  const holding = async (accountId: string) => {
    const [row] = await db
      .insert(schema.holdings)
      .values({ userId: user.id, accountId, tokenId: token.id, balance: '0' })
      .returning();
    if (!row) throw new Error('holding insert failed');
    return row;
  };

  return {
    userId: user.id,
    tokenId: token.id,
    outHoldingId: (await holding(walletAccount.id)).id,
    inHoldingId: (await holding(exchangeAccount.id)).id,
    institutionTypeId: instType.id,
    institutionId: inst.id,
    accountTypeId: acctType.id,
    tokenTypeId: tokenType.id,
  };
}

async function cleanupFixture(f: Fixture): Promise<void> {
  await db.delete(schema.users).where(eq(schema.users.id, f.userId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, f.tokenId));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
  await db
    .delete(schema.institutionTypes)
    .where(eq(schema.institutionTypes.id, f.institutionTypeId));
}

/** A departure carrying the answer that books a disposal, and no timestamp. */
async function insertDeparture(
  f: Fixture,
  opts: { quantity?: string; review?: string | null; kind?: string } = {}
): Promise<string> {
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: f.userId,
      holdingId: f.outHoldingId,
      tokenId: f.tokenId,
      kind: opts.kind ?? 'transfer_out',
      quantity: opts.quantity ?? '-1',
      occurredAt: departedAt(),
      source: 'etherscan',
      externalId: `dep-${randomUUID().slice(0, 8)}`,
      ...(opts.review === undefined
        ? { transferReview: 'left_control' }
        : opts.review === null
          ? {}
          : { transferReview: opts.review }),
    })
    .returning();
  if (!row) throw new Error('departure insert failed');
  return row.id;
}

async function insertArrival(
  f: Fixture,
  opts: {
    quantity?: string;
    minutes?: number;
    holdingId?: string;
    transferGroupId?: string;
  } = {}
): Promise<string> {
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: f.userId,
      holdingId: opts.holdingId ?? f.inHoldingId,
      tokenId: f.tokenId,
      kind: 'deposit',
      quantity: opts.quantity ?? '1',
      occurredAt: minutesLater(opts.minutes ?? 4),
      source: 'kraken-api',
      externalId: `arr-${randomUUID().slice(0, 8)}`,
      ...(opts.transferGroupId ? { transferGroupId: opts.transferGroupId } : {}),
    })
    .returning();
  if (!row) throw new Error('arrival insert failed');
  return row.id;
}

function useCase(): RepairMatchedOutflowsUseCase {
  return new RepairMatchedOutflowsUseCase();
}

beforeEach(async () => {
  fixture = await setupFixture();
});

afterEach(async () => {
  if (fixture) await cleanupFixture(fixture);
  fixture = null;
});

describe('RepairMatchedOutflowsUseCase — deriving the decision', () => {
  test('derives `paired` for the single exact arrival on another holding', async () => {
    const f = fixture!;
    const departure = await insertDeparture(f);
    const arrival = await insertArrival(f);

    const plans = await useCase().plansFor(f.userId);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.transactionId).toBe(departure);
    expect(plans[0]?.action).toBe('paired');
    expect(plans[0]?.arrival?.transactionId).toBe(arrival);
    expect(plans[0]?.arrival?.deltaPct).toBe('0');
    expect(plans[0]?.arrival?.gapMinutes).toBe(4);
  });

  test('admits an arrival short by a FIXED fee that the matcher’s 1% would refuse', async () => {
    const f = fixture!;
    // The measured case: ~0.008 ETH of gas taken by a forwarding deposit
    // address. On 0.5 that is 1.43%, which the matcher refuses, while the same
    // fee on 1.04 is 0.77%, which it admits — one pair of identical events
    // split by a bound that is the wrong shape for a fixed cost.
    await insertDeparture(f, { quantity: '-0.5' });
    await insertArrival(f, { quantity: '0.4928421402' });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('paired');
    expect(plans[0]?.arrival?.deltaPct).toBe('-1.432');
  });

  test('blocks when the only arrival is further out than the fixed-fee bound', async () => {
    const f = fixture!;
    await insertDeparture(f, { quantity: '-1' });
    await insertArrival(f, { quantity: '0.97' });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('blocked');
    expect(plans[0]?.arrival).toBeNull();
    expect(plans[0]?.blockedReason).toContain('outside the 2% bound');
  });

  test('blocks when the only arrival is outside the matcher’s 30-minute window', async () => {
    const f = fixture!;
    // The 78-minute Polygon arrival in production: real, unproven, and it must
    // be REPORTED rather than silently dropped out of the population.
    await insertDeparture(f);
    await insertArrival(f, { minutes: 78 });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('blocked');
    expect(plans[0]?.blockedReason).toContain('78 min later');
  });

  test('blocks when two arrivals could each be the money', async () => {
    const f = fixture!;
    await insertDeparture(f);
    await insertArrival(f, { minutes: 4 });
    await insertArrival(f, { minutes: 6 });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('blocked');
    expect(plans[0]?.candidateCount).toBe(2);
    expect(plans[0]?.blockedReason).toContain('cannot say which one');
  });

  test('offers nothing when the arrival PRECEDES the departure', async () => {
    const f = fixture!;
    await insertDeparture(f);
    await insertArrival(f, { minutes: -4 });

    // `candidatePairClass` allows this for `same_token`, because two vendors'
    // clocks can disagree about one movement. Here the outflow is being told
    // which arrival it BECAME, so direction is asserted, not tolerated.
    expect(await useCase().plansFor(f.userId)).toHaveLength(0);
  });

  test('offers nothing when the arrival is already another movement’s leg', async () => {
    const f = fixture!;
    await insertDeparture(f);
    await insertArrival(f, { transferGroupId: randomUUID() });

    // `claimInflow` refuses a claimed inflow, so a plan built on one would fail
    // at write time — after earlier rows had already been written.
    expect(await useCase().plansFor(f.userId)).toHaveLength(0);
  });

  test('offers nothing when the only arrival sits on the departure’s own holding', async () => {
    const f = fixture!;
    await insertDeparture(f);
    await insertArrival(f, { holdingId: f.outHoldingId });

    // SC-347: a pair resolving to one holding describes a move from a position
    // to itself, and 17 production groups of exactly that shape had to be undone.
    expect(await useCase().plansFor(f.userId)).toHaveLength(0);
  });

  test('ignores a row that does not carry the answer booking a disposal', async () => {
    const f = fixture!;
    await insertDeparture(f, { review: null });
    await insertArrival(f);

    // An unanswered row belongs to the queue and the nightly matcher. This
    // repair exists only to correct `left_control`.
    expect(await useCase().plansFor(f.userId)).toHaveLength(0);
  });
});

describe('RepairMatchedOutflowsUseCase — applying', () => {
  test('claims the existing arrival, stamps `repair`, and invents no row', async () => {
    const f = fixture!;
    const departure = await insertDeparture(f);
    const arrival = await insertArrival(f);

    const repair = useCase();
    const [plan] = await repair.plansFor(f.userId);
    if (!plan) throw new Error('no plan');
    await repair.apply(plan);

    const [out] = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, departure));
    expect(out?.transferReview).toBe('paired');
    expect(out?.transferReviewSource).toBe('repair');
    expect(out?.transferGroupId).not.toBeNull();

    const [inflow] = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, arrival));
    expect(inflow?.transferGroupId).toBe(out?.transferGroupId ?? null);

    // `internal` would have WRITTEN an arrival. For every row this repair
    // covers the arrival is already imported, so that would count it twice.
    const created = await db
      .select({ id: schema.holdingTransactions.id })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.source, 'transfer-review'));
    expect(created.filter((r) => r.id === departure)).toHaveLength(0);
    const all = await db
      .select({ id: schema.holdingTransactions.id })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    expect(all).toHaveLength(2);
  });

  test('refuses to apply a blocked plan', async () => {
    const f = fixture!;
    await insertDeparture(f);
    await insertArrival(f, { minutes: 78 });

    const repair = useCase();
    const [plan] = await repair.plansFor(f.userId);
    if (!plan) throw new Error('no plan');
    expect(repair.apply(plan)).rejects.toThrow('refusing to apply a blocked plan');
  });
});
