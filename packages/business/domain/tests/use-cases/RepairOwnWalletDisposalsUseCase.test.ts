/**
 * `RepairOwnWalletDisposalsUseCase` integration tests (SC-365).
 *
 * The fixture is the production shape, because the decision this makes is only
 * interesting against it: an outflow of USDC from `0xa11c…a6b7` to
 * `0xb0b1…a8b9`, two wallets the same person registered, answered
 * `left_control` by a raw UPDATE that left no record of itself.
 *
 * Same isolation shape as `TransferReviewService.test.ts` and for the same
 * reason: the use case and the service both reach for the global `db`, so
 * `withTestDb`'s rollback cannot wrap them. A fresh user per test scopes every
 * query naturally and `afterEach` cascades it away.
 *
 * What these assert, in one sentence: **the decision is derived, and where the
 * ledger supports no decision the outcome is a refusal rather than a guess.**
 * SC-347 had just finished undoing 17 transfer groups that asserted a movement
 * nobody made, every one produced by a rule that had to answer.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { RepairOwnWalletDisposalsUseCase } from '../../src/use-cases/RepairOwnWalletDisposalsUseCase';

/** The two addresses the ticket is about, in the case the chain reports them. */
const SOURCE_WALLET = '0xa11ce0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7';
const DEST_WALLET = '0xB0B1c2D3e4F5a6B7c8D9e0F1a2B3c4D5e6F7a8B9';
const HASH = '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

interface Fixture {
  userId: string;
  tokenId: string;
  /** `Ethereum - 0xa11c…a6b7 / USDC` — where the money left from. */
  outHoldingId: string;
  outAccountId: string;
  /** `Ethereum - 0xb0b1…a8b9 / USDC` — where it landed. */
  destHoldingId: string;
  destAccountId: string;
  /** The same destination wallet on ANOTHER chain, holding the same token.
   *  Nothing may resolve to it: a wallet is registered once and used on many
   *  chains, and the chain is the only thing telling two of its accounts
   *  apart. */
  otherChainAccountId: string;
  /** A third account with no position in the token at all. */
  emptyAccountId: string;
  institutionTypeId: string;
  institutionId: string;
  accountTypeId: string;
  tokenTypeId: string;
}

let fixture: Fixture | null = null;

function anchor(): Date {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

async function setupFixture(): Promise<Fixture> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `rep-${randomUUID().slice(0, 8)}@scani.local`, name: 'RepairTest' })
    .returning();
  if (!user) throw new Error('user insert failed');

  const [instType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `rep-${randomUUID().slice(0, 6)}`, name: 'Rep Type' })
    .returning();
  if (!instType) throw new Error('instType insert failed');
  const [inst] = await db
    .insert(schema.institutions)
    .values({ name: `Rep-${randomUUID().slice(0, 6)}`, typeId: instType.id })
    .returning();
  if (!inst) throw new Error('inst insert failed');
  const [acctType] = await db
    .insert(schema.accountTypes)
    .values({ code: `rep-acct-${randomUUID().slice(0, 6)}`, name: 'Rep Account' })
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

  // `chainId` is a STRING here because that is what the wallet importer writes.
  const outAccount = await account('eth-0158', { chainId: '1', walletAddress: SOURCE_WALLET });
  const destAccount = await account('eth-1414', { chainId: '1', walletAddress: DEST_WALLET });
  const otherChain = await account('base-1414', { chainId: '8453', walletAddress: DEST_WALLET });
  const emptyAccount = await account('zz-empty', null);

  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `rep-tok-${randomUUID().slice(0, 6)}`, name: 'Rep Token Type' })
    .returning();
  if (!tokenType) throw new Error('tokenType insert failed');
  const [token] = await db
    .insert(schema.tokens)
    .values({ symbol: `RP${randomUUID().toUpperCase()}`, name: 'Rep USDC', typeId: tokenType.id })
    .returning();
  if (!token) throw new Error('token insert failed');

  const holding = async (accountId: string, balance: string) => {
    const [row] = await db
      .insert(schema.holdings)
      .values({ userId: user.id, accountId, tokenId: token.id, balance })
      .returning();
    if (!row) throw new Error('holding insert failed');
    return row;
  };
  const outHolding = await holding(outAccount.id, '0');
  const destHolding = await holding(destAccount.id, '4000.596018');
  await holding(otherChain.id, '0');

  // Both endpoints are wallets this user registered. That is the whole premise:
  // `left_control` books a gain on money that never left the portfolio.
  await db.insert(schema.userWallets).values([
    { userId: user.id, walletAddress: SOURCE_WALLET, institutionIds: [] },
    { userId: user.id, walletAddress: DEST_WALLET, institutionIds: [] },
  ]);

  return {
    userId: user.id,
    tokenId: token.id,
    outHoldingId: outHolding.id,
    outAccountId: outAccount.id,
    destHoldingId: destHolding.id,
    destAccountId: destAccount.id,
    otherChainAccountId: otherChain.id,
    emptyAccountId: emptyAccount.id,
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

/** The SC-365 row: answered `left_control`, with nothing recording who by. */
async function insertDisposal(
  f: Fixture,
  opts: { rawPayload?: Record<string, unknown>; holdingId?: string } = {}
): Promise<string> {
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: f.userId,
      holdingId: opts.holdingId ?? f.outHoldingId,
      tokenId: f.tokenId,
      kind: 'transfer_out',
      quantity: '-83.985269',
      occurredAt: anchor(),
      source: 'etherscan',
      externalId: `sc365-${randomUUID().slice(0, 8)}`,
      transferReview: 'left_control',
      rawPayload: opts.rawPayload ?? { to: DEST_WALLET, from: SOURCE_WALLET, hash: HASH },
    })
    .returning();
  if (!row) throw new Error('disposal insert failed');
  return row.id;
}

async function insertArrival(
  f: Fixture,
  opts: { holdingId: string; hash?: string; quantity?: string; transferGroupId?: string }
): Promise<string> {
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: f.userId,
      holdingId: opts.holdingId,
      tokenId: f.tokenId,
      kind: 'transfer_in',
      quantity: opts.quantity ?? '83.985269',
      occurredAt: anchor(),
      source: 'etherscan',
      externalId: `arr-${randomUUID().slice(0, 8)}`,
      rawPayload: { to: DEST_WALLET, from: SOURCE_WALLET, hash: opts.hash ?? HASH },
      ...(opts.transferGroupId ? { transferGroupId: opts.transferGroupId } : {}),
    })
    .returning();
  if (!row) throw new Error('arrival insert failed');
  return row.id;
}

function useCase(): RepairOwnWalletDisposalsUseCase {
  return new RepairOwnWalletDisposalsUseCase();
}

beforeEach(async () => {
  fixture = await setupFixture();
});

afterEach(async () => {
  if (fixture) await cleanupFixture(fixture);
  fixture = null;
});

describe('RepairOwnWalletDisposalsUseCase — deriving the decision', () => {
  test('derives `internal` when the chain transaction has no imported arrival', async () => {
    const f = fixture!;
    // The measured production case. `0xb0b1…a8b9`'s own history was never
    // fetched — its credential lost the unique (user, institution) slot, which
    // is what migration 0045 is about — so there is no arrival row to pair to
    // and the destination holding exists only because the balance sync made it.
    const id = await insertDisposal(f);

    const [plan] = await useCase().plansFor(f.userId);
    expect(plan?.disposal.transactionId).toBe(id);
    expect(plan?.action).toBe('internal');
    expect(plan?.destination).toEqual({ accountId: f.destAccountId, holdingId: f.destHoldingId });
    // The other-chain account holds the SAME wallet and the SAME token.
    expect(plan?.destination?.accountId).not.toBe(f.otherChainAccountId);
  });

  test('derives `paired` when an arrival on the same hash is already in the ledger', async () => {
    const f = fixture!;
    const id = await insertDisposal(f);
    const arrival = await insertArrival(f, { holdingId: f.destHoldingId });

    const [plan] = await useCase().plansFor(f.userId);
    expect(plan?.disposal.transactionId).toBe(id);
    expect(plan?.action).toBe('paired');
    expect(plan?.matchTransactionId).toBe(arrival);
    expect(plan?.blockingGroupId).toBeNull();
  });

  test('reports the matcher group that must be unlinked before the arrival can be claimed', async () => {
    const f = fixture!;
    // `claimInflow` will not take a claimed inflow, so a repair that did not
    // notice this would fail with `partner_gone` and change nothing (SC-350).
    const groupId = randomUUID();
    await insertDisposal(f);
    await insertArrival(f, { holdingId: f.destHoldingId, transferGroupId: groupId });

    const [plan] = await useCase().plansFor(f.userId);
    expect(plan?.action).toBe('paired');
    expect(plan?.blockingGroupId).toBe(groupId);
  });

  test('an arrival on a DIFFERENT hash is not this transfer', async () => {
    const f = fixture!;
    await insertDisposal(f);
    await insertArrival(f, { holdingId: f.destHoldingId, hash: `0x${'ab'.repeat(32)}` });

    const [plan] = await useCase().plansFor(f.userId);
    expect(plan?.action).toBe('internal');
  });
});

describe('RepairOwnWalletDisposalsUseCase — refusing rather than guessing', () => {
  test('blocks when the only arrival sits on the outflow’s OWN holding (SC-347)', async () => {
    const f = fixture!;
    // A group whose two legs share one holding is a no-op that
    // `CostBasisService`'s two folds disagreed about, and 17 of production's
    // 43 same-holding groups were exactly this artifact. Manufacturing a
    // fresh one to close a ticket is the mistake SC-347 spent itself undoing.
    await insertDisposal(f);
    await insertArrival(f, { holdingId: f.outHoldingId });

    const [plan] = await useCase().plansFor(f.userId);
    expect(plan?.action).toBe('blocked');
    expect(plan?.blockedReason).toContain('same holding');
  });

  test('blocks when two arrivals on the hash could each be the money', async () => {
    const f = fixture!;
    await insertDisposal(f);
    await insertArrival(f, { holdingId: f.destHoldingId });
    await insertArrival(f, { holdingId: f.destHoldingId, quantity: '10' });

    const [plan] = await useCase().plansFor(f.userId);
    expect(plan?.action).toBe('blocked');
    expect(plan?.blockedReason).toContain('ambiguous');
  });

  test('blocks a row with no transaction hash — the paired/internal question is unanswerable', async () => {
    const f = fixture!;
    await insertDisposal(f, { rawPayload: { to: DEST_WALLET, from: SOURCE_WALLET } });

    const [plan] = await useCase().plansFor(f.userId);
    expect(plan?.action).toBe('blocked');
    expect(plan?.blockedReason).toContain('no transaction hash');
  });

  test('blocks when the destination account tracks no position in the token (SC-187)', async () => {
    const f = fixture!;
    // `writeInflow` would CREATE the holding, opened at the amount that moved
    // and with a source `HoldingsSyncHelper` skips — a balance no sync can
    // ever retract. SC-350 could zero it because a sync had just shown those
    // wallets holding none of the token; that was a measurement, not a rule.
    await db.delete(schema.holdings).where(eq(schema.holdings.id, f.destHoldingId));
    await insertDisposal(f);

    const [plan] = await useCase().plansFor(f.userId);
    expect(plan?.action).toBe('blocked');
    expect(plan?.blockedReason).toContain('SC-187');
  });

  test('blocks when no account holds the destination wallet on this chain', async () => {
    const f = fixture!;
    await db.delete(schema.accounts).where(eq(schema.accounts.id, f.destAccountId));
    await insertDisposal(f);

    const [plan] = await useCase().plansFor(f.userId);
    expect(plan?.action).toBe('blocked');
    expect(plan?.blockedReason).toContain('0 accounts');
  });

  test('blocks a row already carrying a transfer_group_id', async () => {
    const f = fixture!;
    const id = await insertDisposal(f);
    await db
      .update(schema.holdingTransactions)
      .set({ transferGroupId: randomUUID() })
      .where(eq(schema.holdingTransactions.id, id));

    const [plan] = await useCase().plansFor(f.userId);
    expect(plan?.action).toBe('blocked');
    expect(plan?.blockedReason).toContain('already carries');
  });
});

describe('RepairOwnWalletDisposalsUseCase — applying', () => {
  test('an `internal` repair stamps `repair`, links both legs and writes the arrival', async () => {
    const f = fixture!;
    const id = await insertDisposal(f);
    const [plan] = await useCase().plansFor(f.userId);
    await useCase().apply(plan!);

    const [row] = await db
      .select({
        review: schema.holdingTransactions.transferReview,
        source: schema.holdingTransactions.transferReviewSource,
        groupId: schema.holdingTransactions.transferGroupId,
      })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, id));
    expect(row?.review).toBe('internal');
    // Not `user` — he answered the opposite — and not NULL, which would file a
    // deliberate correction beside the raw UPDATE it is correcting (SC-350).
    expect(row?.source).toBe('repair');
    expect(row?.groupId).not.toBeNull();

    // The arrival `internal` writes, keyed on the outflow's id so reopening
    // can find and delete it.
    const created = await db
      .select({ id: schema.holdingTransactions.id })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.externalId, id));
    expect(created).toHaveLength(1);

    // And the invariant now holds for this user.
    expect(await useCase().plansFor(f.userId)).toEqual([]);
  });

  test('a `paired` repair claims the existing arrival and writes no second one', async () => {
    const f = fixture!;
    const id = await insertDisposal(f);
    const arrival = await insertArrival(f, { holdingId: f.destHoldingId });
    const [plan] = await useCase().plansFor(f.userId);
    await useCase().apply(plan!);

    const rows = await db
      .select({
        id: schema.holdingTransactions.id,
        groupId: schema.holdingTransactions.transferGroupId,
        externalId: schema.holdingTransactions.externalId,
      })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    const outflow = rows.find((r) => r.id === id);
    const inflow = rows.find((r) => r.id === arrival);
    expect(outflow?.groupId).not.toBeNull();
    expect(inflow?.groupId).toBe(outflow?.groupId as string);
    // Double-counting the arrival is the one thing the paired/internal split
    // exists to prevent.
    expect(rows.filter((r) => r.externalId === id)).toHaveLength(0);
  });

  test('refuses to apply a blocked plan rather than picking one of the answers', async () => {
    const f = fixture!;
    await insertDisposal(f, { rawPayload: { to: DEST_WALLET, from: SOURCE_WALLET } });
    const [plan] = await useCase().plansFor(f.userId);
    expect(useCase().apply(plan!)).rejects.toThrow('refusing to apply a blocked plan');
  });
});
