/**
 * `RepairProtocolDepositOutflowsUseCase` integration tests (SC-377).
 *
 * The fixture is the production shape: an ETH outflow from a mainnet wallet
 * whose `raw_payload` names a protocol deposit entrypoint — WETH9's
 * `deposit()` or the Aave v2 WETHGateway's `depositETH`.
 *
 * Same isolation shape as `RepairMatchedOutflowsUseCase.test.ts` and for the
 * same reason: the use case and `TransferReviewService` both reach for the
 * global `db`, so `withTestDb`'s rollback cannot wrap them. A fresh user per
 * test scopes every query and `afterEach` cascades it away.
 *
 * What these assert in one sentence: **an outflow stops booking a disposal
 * only when the contract, the selector, the calldata and the receipt status
 * all say the value came back to the sender, and every other shape is a
 * refusal rather than a guess.** The failure this guards is the expensive one
 * in the other direction: answering `untracked` on ETH that genuinely left
 * hides a real disposal, which is the mirror of the invented gain SC-150
 * exists to stop.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { RepairProtocolDepositOutflowsUseCase } from '@scani/domain/use-cases/RepairProtocolDepositOutflowsUseCase';
import { eq } from 'drizzle-orm';

const WALLET = '0x01583d152e3225519d211b1f576d959f70ef9630';
const WETH9 = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const AAVE_WETH_GATEWAY = '0xcc9a0b7c43dc2a5f023bb9b738e45b0ef6b06e04';
const AAVE_V2_LENDING_POOL = '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9';
const STRANGER = '0x5863f4a2d6b8f0a1c9e2b7d4f1a3c5e7b9d1f3a5';

interface Fixture {
  userId: string;
  tokenId: string;
  holdingId: string;
  /** A holding on an account with no `chainId` — an exchange, not a chain. */
  offChainHoldingId: string;
  institutionTypeId: string;
  institutionId: string;
  accountTypeId: string;
  tokenTypeId: string;
}

let fixture: Fixture | null = null;

function word(address: string): string {
  return address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

/** The production calldata shape: selector + lendingPool + onBehalfOf + referral. */
function depositEthInput(onBehalfOf: string): string {
  return `0x474cf53d${word(AAVE_V2_LENDING_POOL)}${word(onBehalfOf)}${word('0x0')}`;
}

async function setupFixture(): Promise<Fixture> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `pd-${randomUUID().slice(0, 8)}@scani.local`, name: 'ProtocolDepositTest' })
    .returning();
  if (!user) throw new Error('user insert failed');

  const [instType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `pd-${randomUUID().slice(0, 6)}`, name: 'PD Type' })
    .returning();
  if (!instType) throw new Error('instType insert failed');
  const [inst] = await db
    .insert(schema.institutions)
    .values({ name: `PD-${randomUUID().slice(0, 6)}`, typeId: instType.id })
    .returning();
  if (!inst) throw new Error('inst insert failed');
  const [acctType] = await db
    .insert(schema.accountTypes)
    .values({ code: `pd-acct-${randomUUID().slice(0, 6)}`, name: 'PD Account' })
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
  const mainnet = await account('eth-0158', { chainId: '1', walletAddress: WALLET });
  const exchange = await account('kraken-main', null);

  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `pd-tok-${randomUUID().slice(0, 6)}`, name: 'PD Token Type' })
    .returning();
  if (!tokenType) throw new Error('tokenType insert failed');
  const [token] = await db
    .insert(schema.tokens)
    .values({ symbol: `PD${randomUUID().toUpperCase()}`, name: 'PD Ether', typeId: tokenType.id })
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
    holdingId: (await holding(mainnet.id)).id,
    offChainHoldingId: (await holding(exchange.id)).id,
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

/** A wrap, exactly as production carries it, with the row's fields overridable. */
async function insertWrap(
  f: Fixture,
  opts: {
    quantity?: string;
    payload?: Record<string, unknown>;
    holdingId?: string;
    review?: string | null;
    reviewedAt?: Date;
    reviewSource?: string;
    transferGroupId?: string;
  } = {}
): Promise<string> {
  const quantity = opts.quantity ?? '-0.02';
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: f.userId,
      holdingId: opts.holdingId ?? f.holdingId,
      tokenId: f.tokenId,
      kind: 'transfer_out',
      quantity,
      occurredAt: new Date('2021-11-30T13:29:11Z'),
      source: 'etherscan',
      externalId: `wrap-${randomUUID().slice(0, 8)}`,
      rawPayload: {
        to: WETH9,
        from: WALLET,
        hash: `0x${randomUUID().replace(/-/g, '')}`,
        input: '0xd0e30db0',
        value: '20000000000000000',
        isError: '0',
        methodId: '0xd0e30db0',
        functionName: 'deposit()',
        contractAddress: '',
        txreceipt_status: '1',
        ...opts.payload,
      },
      ...(opts.review === undefined
        ? { transferReview: 'left_control' }
        : opts.review === null
          ? {}
          : { transferReview: opts.review }),
      ...(opts.reviewedAt ? { transferReviewedAt: opts.reviewedAt } : {}),
      ...(opts.reviewSource ? { transferReviewSource: opts.reviewSource } : {}),
      ...(opts.transferGroupId ? { transferGroupId: opts.transferGroupId } : {}),
    })
    .returning();
  if (!row) throw new Error('wrap insert failed');
  return row.id;
}

async function insertAaveDeposit(f: Fixture, opts: { onBehalfOf?: string } = {}): Promise<string> {
  const beneficiary = opts.onBehalfOf ?? WALLET;
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: f.userId,
      holdingId: f.holdingId,
      tokenId: f.tokenId,
      kind: 'transfer_out',
      quantity: '-0.198093981517794548',
      occurredAt: new Date('2022-09-06T08:42:55Z'),
      source: 'etherscan',
      externalId: `aave-${randomUUID().slice(0, 8)}`,
      transferReview: 'left_control',
      rawPayload: {
        to: AAVE_WETH_GATEWAY,
        from: WALLET,
        hash: `0x${randomUUID().replace(/-/g, '')}`,
        input: depositEthInput(beneficiary),
        value: '198093981517794548',
        isError: '0',
        methodId: '0x474cf53d',
        functionName: 'depositETH(address lendingPool, address onBehalfOf, uint16 referralCode)',
        contractAddress: '',
        txreceipt_status: '1',
      },
    })
    .returning();
  if (!row) throw new Error('aave insert failed');
  return row.id;
}

function useCase(): RepairProtocolDepositOutflowsUseCase {
  return new RepairProtocolDepositOutflowsUseCase();
}

beforeEach(async () => {
  fixture = await setupFixture();
});

afterEach(async () => {
  if (fixture) await cleanupFixture(fixture);
  fixture = null;
});

describe('RepairProtocolDepositOutflowsUseCase — deriving the decision', () => {
  test('derives `untracked` for a WETH9 wrap', async () => {
    const f = fixture!;
    const id = await insertWrap(f);

    const plans = await useCase().plansFor(f.userId);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.transactionId).toBe(id);
    expect(plans[0]?.action).toBe('untracked');
    expect(plans[0]?.protocol).toBe('weth9-wrap');
    expect(plans[0]?.quantity).toBe('0.02');
  });

  test('derives `untracked` for an Aave depositETH whose onBehalfOf is the sender', async () => {
    const f = fixture!;
    const id = await insertAaveDeposit(f);

    const plans = await useCase().plansFor(f.userId);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.transactionId).toBe(id);
    expect(plans[0]?.action).toBe('untracked');
    expect(plans[0]?.protocol).toBe('aave-v2-weth-gateway');
  });

  test('BLOCKS an Aave depositETH made on behalf of somebody else', async () => {
    const f = fixture!;
    // The aWETH is minted to a stranger, so the ETH really did leave and
    // `left_control` is right about it.
    await insertAaveDeposit(f, { onBehalfOf: STRANGER });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('blocked');
    expect(plans[0]?.blockedReason).toContain(STRANGER);
  });

  test('ignores a row whose selector is not a registered entrypoint', async () => {
    const f = fixture!;
    // Same contract, different call: WETH9's `withdraw(uint256)`.
    await insertWrap(f, { payload: { methodId: '0x2e1a7d4d', input: '0x2e1a7d4d' } });

    expect(await useCase().plansFor(f.userId)).toHaveLength(0);
  });

  test('ignores a registered selector sent to a different contract', async () => {
    const f = fixture!;
    // `0xd0e30db0` is the selector of every zero-argument `deposit()` ever
    // written, so the address is what makes it WETH9.
    await insertWrap(f, { payload: { to: STRANGER } });

    expect(await useCase().plansFor(f.userId)).toHaveLength(0);
  });

  test('ignores the same contract and selector on another chain', async () => {
    const f = fixture!;
    // Twenty bytes mean nothing without a chain: the same address on Base is a
    // different contract.
    await insertWrap(f, { holdingId: f.offChainHoldingId });

    expect(await useCase().plansFor(f.userId)).toHaveLength(0);
  });
});

describe('RepairProtocolDepositOutflowsUseCase — the refusals', () => {
  /**
   * STILL BLOCKED, FOR AN HONEST REASON NOW (SC-673).
   *
   * This test was titled *"BLOCKS a row a person answered, identified by its
   * timestamp"* — and the row's timestamp is the only evidence there is. It was
   * a fair reading when written, because every write path stamped both columns
   * and 560 of 561 answered rows had no timestamp at all (SC-324), so *stamped*
   * and *a person answered* were the same set. Rows later acquired timestamps
   * without sources and the two came apart.
   *
   * **The refusal must not change.** A row that may be a person's answer is one
   * a repair must leave alone, and the fix to the DISPLAY had to not become a
   * licence for the WRITER — see `mayBeUserAnswer`. What changes is only the
   * sentence: the repair no longer tells the reader a person answered when what
   * it has is a date.
   */
  test('BLOCKS a row with a review timestamp and no source, saying which it has', async () => {
    const f = fixture!;
    await insertWrap(f, { reviewedAt: new Date('2026-08-17T08:31:00Z') });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('blocked');
    expect(plans[0]?.blockedReason).toContain('no source');
    expect(plans[0]?.blockedReason).not.toContain('answered by a person');
  });

  test('BLOCKS a row a person answered, identified by its source', async () => {
    const f = fixture!;
    await insertWrap(f, { reviewSource: 'user' });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('blocked');
    expect(plans[0]?.blockedReason).toContain('answered by a person');
  });

  test('BLOCKS a row that books no disposal today', async () => {
    const f = fixture!;
    await insertWrap(f, { review: 'untracked' });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('blocked');
    expect(plans[0]?.blockedReason).toContain("not 'left_control'");
  });

  test('BLOCKS an unanswered row — it is a live question, not a wrong answer', async () => {
    const f = fixture!;
    await insertWrap(f, { review: null });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('blocked');
    expect(plans[0]?.blockedReason).toContain('unanswered');
  });

  test('BLOCKS a row already carrying a transfer group', async () => {
    const f = fixture!;
    await insertWrap(f, { transferGroupId: randomUUID() });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('blocked');
    expect(plans[0]?.blockedReason).toContain('transfer_group_id');
  });

  test('BLOCKS a reverted call — the ETH came back, so nothing is wrong', async () => {
    const f = fixture!;
    await insertWrap(f, { payload: { isError: '1', txreceipt_status: '0' } });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('blocked');
    expect(plans[0]?.blockedReason).toContain('did not succeed');
  });

  test('BLOCKS a row whose quantity is not the value the contract received', async () => {
    const f = fixture!;
    await insertWrap(f, { quantity: '-0.03' });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('blocked');
    expect(plans[0]?.blockedReason).toContain('does not match quantity');
  });

  test('BLOCKS an ERC-20 leg that names a token contract', async () => {
    const f = fixture!;
    await insertWrap(f, { payload: { contractAddress: WETH9 } });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('blocked');
    expect(plans[0]?.blockedReason).toContain('not native');
  });

  test('BLOCKS an inflow — the claim is about money leaving', async () => {
    const f = fixture!;
    await insertWrap(f, { quantity: '0.02' });

    const plans = await useCase().plansFor(f.userId);
    expect(plans[0]?.action).toBe('blocked');
    expect(plans[0]?.blockedReason).toContain('not an outflow');
  });

  test('refuses to apply a blocked plan', async () => {
    const f = fixture!;
    await insertWrap(f, { reviewSource: 'user' });

    const [plan] = await useCase().plansFor(f.userId);
    expect(plan).toBeDefined();
    if (!plan) return;
    await expect(useCase().apply(plan)).rejects.toThrow('refusing to apply a blocked plan');
  });
});

describe('RepairProtocolDepositOutflowsUseCase — applying', () => {
  test('writes `untracked` with answerSource `repair` and links nothing', async () => {
    const f = fixture!;
    const id = await insertWrap(f);

    const [plan] = await useCase().plansFor(f.userId);
    expect(plan?.action).toBe('untracked');
    if (!plan) return;
    await useCase().apply(plan);

    const [row] = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, id));
    expect(row?.transferReview).toBe('untracked');
    expect(row?.transferReviewSource).toBe('repair');
    expect(row?.transferReviewedAt).not.toBeNull();
    // `untracked` asserts no movement, so a group id would carry the lots to a
    // leg that does not exist.
    expect(row?.transferGroupId).toBeNull();
  });

  test('invents no arrival — nothing may be written on the user’s behalf', async () => {
    const f = fixture!;
    await insertWrap(f);
    const before = await db
      .select({ id: schema.holdingTransactions.id })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));

    const [plan] = await useCase().plansFor(f.userId);
    if (!plan) return;
    await useCase().apply(plan);

    const after = await db
      .select({ id: schema.holdingTransactions.id })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    expect(after).toHaveLength(before.length);
  });

  test('is idempotent in effect: a second plansFor no longer offers the row', async () => {
    const f = fixture!;
    await insertWrap(f);

    const [plan] = await useCase().plansFor(f.userId);
    if (!plan) return;
    await useCase().apply(plan);

    const again = await useCase().plansFor(f.userId);
    expect(again[0]?.action).toBe('blocked');
    // Blocked on the answer, not on the attribution: the row no longer books a
    // disposal, which is the whole point.
    expect(again[0]?.blockedReason).toContain("not 'left_control'");
  });
});
