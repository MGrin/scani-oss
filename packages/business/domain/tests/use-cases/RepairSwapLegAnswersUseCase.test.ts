/**
 * `RepairSwapLegAnswersUseCase` integration tests (SC-338).
 *
 * The fixture is the production shape: an EVM outflow answered `left_control`
 * by the 2026-08-14 raw `UPDATE` while it was a `transfer_out`, later
 * re-imported as a `swap_out` with a `swap_group_id` and a `swap_in` partner.
 *
 * Same isolation shape as `RepairProtocolDepositOutflowsUseCase.test.ts` and
 * for the same reason: the use case and `TransferReviewService` both reach for
 * the global `db`, so `withTestDb`'s rollback cannot wrap them. A fresh user
 * per test scopes every query and `afterEach` cascades it away.
 *
 * What these assert in one sentence: **an answer is withdrawn only from a row
 * whose kind the review queue can never ask about, that nobody stamped, that
 * carries no link and no split, and whose swap linkage is actually there — and
 * every other shape is a refusal rather than a guess.** The failure this
 * guards is the expensive one: a method that can clear `transfer_review` is one
 * revision away from clearing a `left_control` on a `transfer_out`, which would
 * un-book a real disposal and put it silently back in the queue.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { TransferReviewService } from '@scani/domain/services/TransferReviewService';
import { RepairSwapLegAnswersUseCase } from '@scani/domain/use-cases/RepairSwapLegAnswersUseCase';
import { eq } from 'drizzle-orm';

const WALLET = '0xa11ce0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7';
const ZERO_EX = '0xdef1c0ded9bec7f1a1670819833240f027b25eff';

interface Fixture {
  userId: string;
  tokenId: string;
  counterTokenId: string;
  holdingId: string;
  institutionTypeId: string;
  institutionId: string;
  accountTypeId: string;
  tokenTypeId: string;
}

let fixture: Fixture | null = null;

async function setupFixture(): Promise<Fixture> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sl-${randomUUID().slice(0, 8)}@scani.local`, name: 'SwapLegTest' })
    .returning();
  if (!user) throw new Error('user insert failed');

  const [instType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `sl-${randomUUID().slice(0, 6)}`, name: 'SL Type' })
    .returning();
  if (!instType) throw new Error('instType insert failed');
  const [inst] = await db
    .insert(schema.institutions)
    .values({ name: `SL-${randomUUID().slice(0, 6)}`, typeId: instType.id })
    .returning();
  if (!inst) throw new Error('inst insert failed');
  const [acctType] = await db
    .insert(schema.accountTypes)
    .values({ code: `sl-acct-${randomUUID().slice(0, 6)}`, name: 'SL Account' })
    .returning();
  if (!acctType) throw new Error('acctType insert failed');

  const [account] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: inst.id,
      typeId: acctType.id,
      name: `eth-0158-${randomUUID().slice(0, 6)}`,
      metadata: { chainId: '1', walletAddress: WALLET },
    })
    .returning();
  if (!account) throw new Error('account insert failed');

  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `sl-tok-${randomUUID().slice(0, 6)}`, name: 'SL Token Type' })
    .returning();
  if (!tokenType) throw new Error('tokenType insert failed');
  const [token] = await db
    .insert(schema.tokens)
    .values({ symbol: `SL${randomUUID().toUpperCase()}`, name: 'SL Ether', typeId: tokenType.id })
    .returning();
  if (!token) throw new Error('token insert failed');
  const [counterToken] = await db
    .insert(schema.tokens)
    .values({ symbol: `SC${randomUUID().toUpperCase()}`, name: 'SL Dollar', typeId: tokenType.id })
    .returning();
  if (!counterToken) throw new Error('counterToken insert failed');

  const [holding] = await db
    .insert(schema.holdings)
    .values({ userId: user.id, accountId: account.id, tokenId: token.id, balance: '0' })
    .returning();
  if (!holding) throw new Error('holding insert failed');

  return {
    userId: user.id,
    tokenId: token.id,
    counterTokenId: counterToken.id,
    holdingId: holding.id,
    institutionTypeId: instType.id,
    institutionId: inst.id,
    accountTypeId: acctType.id,
    tokenTypeId: tokenType.id,
  };
}

async function cleanupFixture(f: Fixture): Promise<void> {
  await db.delete(schema.users).where(eq(schema.users.id, f.userId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, f.tokenId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, f.counterTokenId));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
  await db
    .delete(schema.institutionTypes)
    .where(eq(schema.institutionTypes.id, f.institutionTypeId));
}

/**
 * A swap leg, exactly as production carries it: `swap_out` with a
 * `swap_group_id`, priced, and still holding the answer it was given while it
 * was a `transfer_out`.
 */
async function insertSwapLeg(
  f: Fixture,
  opts: {
    kind?: string;
    review?: string | null;
    reviewedAt?: Date;
    reviewSource?: string;
    reviewSplit?: unknown;
    swapGroupId?: string | null;
    transferGroupId?: string;
  } = {}
): Promise<string> {
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: f.userId,
      holdingId: f.holdingId,
      tokenId: f.tokenId,
      kind: opts.kind ?? 'swap_out',
      quantity: '-0.0863',
      occurredAt: new Date('2022-10-15T11:04:23Z'),
      source: 'etherscan',
      externalId: `swap-${randomUUID().slice(0, 8)}`,
      priceNative: '1274.6264310544611819',
      counterTokenId: f.counterTokenId,
      counterQuantity: '110.000261',
      swapGroupId: opts.swapGroupId === undefined ? randomUUID() : (opts.swapGroupId ?? null),
      rawPayload: {
        to: ZERO_EX,
        from: WALLET,
        hash: `0x${randomUUID().replace(/-/g, '')}`,
        methodId: '0x415565b0',
        functionName: '0x415565b0()',
        contractAddress: '',
        txreceipt_status: '1',
      },
      ...(opts.review === undefined
        ? { transferReview: 'left_control' }
        : opts.review === null
          ? {}
          : { transferReview: opts.review }),
      ...(opts.reviewedAt ? { transferReviewedAt: opts.reviewedAt } : {}),
      ...(opts.reviewSource ? { transferReviewSource: opts.reviewSource } : {}),
      ...(opts.reviewSplit ? { transferReviewSplit: opts.reviewSplit } : {}),
      ...(opts.transferGroupId ? { transferGroupId: opts.transferGroupId } : {}),
    })
    .returning();
  if (!row) throw new Error('swap leg insert failed');
  return row.id;
}

function useCase(): RepairSwapLegAnswersUseCase {
  return new RepairSwapLegAnswersUseCase();
}

beforeEach(async () => {
  fixture = await setupFixture();
});

afterEach(async () => {
  if (fixture) await cleanupFixture(fixture);
  fixture = null;
});

describe('RepairSwapLegAnswersUseCase.plansFor', () => {
  test('derives clear for an unattributed left_control on a linked swap leg', async () => {
    const f = fixture as Fixture;
    const id = await insertSwapLeg(f);

    const plans = await useCase().plansFor(f.userId);

    expect(plans).toHaveLength(1);
    expect(plans[0]?.transactionId).toBe(id);
    expect(plans[0]?.action).toBe('clear');
    expect(plans[0]?.answer).toBe('left_control');
    expect(plans[0]?.kind).toBe('swap_out');
    // Reported as an absolute amount, so the plan reads as what moved.
    expect(plans[0]?.quantity).toBe('0.0863');
    expect(plans[0]?.functionName).toBe('0x415565b0()');
  });

  test('ignores an answered transfer_out — the queue CAN ask about that one', async () => {
    const f = fixture as Fixture;
    // The failure this guards is the only one that costs money: a
    // `transfer_out` answered `left_control` books a real disposal, and
    // withdrawing that answer would un-book it and put the row back in the
    // queue with no record of why.
    await insertSwapLeg(f, { kind: 'transfer_out', swapGroupId: null });

    expect(await useCase().plansFor(f.userId)).toHaveLength(0);
  });

  test('ignores an answered withdraw for the same reason', async () => {
    const f = fixture as Fixture;
    await insertSwapLeg(f, { kind: 'withdraw', swapGroupId: null });

    expect(await useCase().plansFor(f.userId)).toHaveLength(0);
  });

  test('ignores an unanswered swap leg — there is nothing to withdraw', async () => {
    const f = fixture as Fixture;
    await insertSwapLeg(f, { review: null });

    expect(await useCase().plansFor(f.userId)).toHaveLength(0);
  });

  test('blocks a stamped answer rather than withdrawing a judgement', async () => {
    const f = fixture as Fixture;
    await insertSwapLeg(f, { reviewedAt: new Date('2026-08-16T09:00:00Z'), reviewSource: 'user' });

    const [plan] = await useCase().plansFor(f.userId);

    expect(plan?.action).toBe('blocked');
    expect(plan?.blockedReason).toContain('answered by a person');
  });

  test('blocks a linked row — reopen is the operation for that', async () => {
    const f = fixture as Fixture;
    await insertSwapLeg(f, { transferGroupId: randomUUID() });

    const [plan] = await useCase().plansFor(f.userId);

    expect(plan?.action).toBe('blocked');
    expect(plan?.blockedReason).toContain('transfer_group_id');
  });

  test('blocks a split answer, which cannot be withdrawn in part', async () => {
    const f = fixture as Fixture;
    await insertSwapLeg(f, {
      review: 'split',
      reviewSplit: [{ decision: 'left_control', quantity: '0.0863' }],
    });

    const [plan] = await useCase().plansFor(f.userId);

    expect(plan?.action).toBe('blocked');
    expect(plan?.blockedReason).toContain('split');
  });

  test('blocks a swap leg with no swap_group_id — the linkage is the justification', async () => {
    const f = fixture as Fixture;
    await insertSwapLeg(f, { swapGroupId: null });

    const [plan] = await useCase().plansFor(f.userId);

    expect(plan?.action).toBe('blocked');
    expect(plan?.blockedReason).toContain('swap_group_id');
  });
});

describe('RepairSwapLegAnswersUseCase.apply', () => {
  test('withdraws the answer, stamps repair, and leaves the swap linkage intact', async () => {
    const f = fixture as Fixture;
    const id = await insertSwapLeg(f);
    const [plan] = await useCase().plansFor(f.userId);
    if (!plan) throw new Error('no plan derived');

    await useCase().apply(plan);

    const [row] = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, id));
    expect(row?.transferReview).toBeNull();
    expect(row?.transferReviewedAt).toBeNull();
    expect(row?.transferReviewSplit).toBeNull();
    // "Unanswered, and not by the user" — the pair that keeps this repair from
    // being another change with no record of who made it.
    expect(row?.transferReviewSource).toBe('repair');
    // The kind and the linkage are what made the answer inapplicable. Losing
    // either here would mean the repair removed its own justification.
    expect(row?.kind).toBe('swap_out');
    expect(row?.swapGroupId).not.toBeNull();
  });

  test('refuses to apply a blocked plan', async () => {
    const f = fixture as Fixture;
    await insertSwapLeg(f, { reviewedAt: new Date('2026-08-16T09:00:00Z'), reviewSource: 'user' });
    const [plan] = await useCase().plansFor(f.userId);
    if (!plan) throw new Error('no plan derived');

    expect(useCase().apply(plan)).rejects.toThrow(/refusing to apply/);
  });
});

describe('TransferReviewService.clearInapplicableAnswer', () => {
  test('refuses a kind the review queue can ask about, whatever the caller says', async () => {
    const f = fixture as Fixture;
    // The containment, tested at the service rather than through the use case:
    // the gate has to hold for a caller that never consulted a plan.
    const id = await insertSwapLeg(f, { kind: 'transfer_out', swapGroupId: null });

    const result = await new TransferReviewService().clearInapplicableAnswer(f.userId, id);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toBe('answerable_kind');
    const [row] = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, id));
    expect(row?.transferReview).toBe('left_control');
  });

  test('refuses a row that carries no answer', async () => {
    const f = fixture as Fixture;
    const id = await insertSwapLeg(f, { review: null });

    const result = await new TransferReviewService().clearInapplicableAnswer(f.userId, id);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toBe('not_answered');
  });

  test('refuses a linked row', async () => {
    const f = fixture as Fixture;
    const id = await insertSwapLeg(f, { transferGroupId: randomUUID() });

    const result = await new TransferReviewService().clearInapplicableAnswer(f.userId, id);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toBe('linked');
  });

  test("refuses another user's row", async () => {
    const f = fixture as Fixture;
    const id = await insertSwapLeg(f);

    const result = await new TransferReviewService().clearInapplicableAnswer(randomUUID(), id);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toBe('not_found');
  });
});
