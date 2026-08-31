/**
 * `TransferReviewService` integration tests (SC-150).
 *
 * Same isolation shape as `LinkTransferPairsUseCase.test.ts` and for the same
 * reason: the service reaches for the global `db` rather than an injected
 * transaction, so `withTestDb`'s rollback cannot wrap it. A fresh user per
 * test scopes every query naturally, and `afterEach` cascades it away.
 *
 * These are integration tests rather than stubbed-DI ones on purpose. Nearly
 * everything this service asserts *is* the SQL — that the queue is exactly the
 * rows the matcher declined, that a decision is atomic across two rows, that
 * reopening clears both legs — and a stubbed repository would be a test of the
 * stub.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { counterpartyFromPayload, normalizeCounterparty, undoEntriesFor } from '@scani/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';

import { counterpartyKeySql, pendingPredicate } from '../../src/lib/transfer-review-queue';
import { sameHoldingRepairPlan, unlinkPairRefusal } from '../../src/lib/transfer-unlink';
import { upstreamEventKey } from '../../src/lib/upstream-event';
import { HoldingBalanceObservationRepository } from '../../src/repositories/HoldingBalanceObservationRepository';
import { HOLDING_OPEN_OBSERVATION_SOURCE } from '../../src/services/holdings/HoldingService';
import {
  MalformedCursorError,
  TransferReviewService,
} from '../../src/services/TransferReviewService';
import { RecordHoldingMovementUseCase } from '../../src/use-cases/RecordHoldingMovementUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

interface Fixture {
  userId: string;
  tokenId: string;
  outHoldingId: string;
  inHoldingId: string;
  /** A SECOND holding of the same token in the same account as the outflow —
   *  the production Airwallex shape, where money moved between two USD
   *  holdings of one account (SC-187). */
  sameAccountHoldingId: string;
  outAccountId: string;
  inAccountId: string;
  /** An account that tracks no position in this token at all, and that no
   *  balance sync owns — the hand-maintained destination SC-187 was built
   *  for. */
  emptyAccountId: string;
  /** Tracks no position either, but the hourly `wallet-balances` sync owns
   *  it (SC-356). */
  walletSyncedAccountId: string;
  /** The same, for the hourly `exchange-balances` sync. */
  exchangeSyncedAccountId: string;
  /** The same asset as `tokenId`, as a second token row on a second chain —
   *  what a bridge's two legs actually look like (SC-336). */
  bridgeTokenId: string;
  bridgeHoldingId: string;
  institutionTypeId: string;
  institutionId: string;
  exchangeInstitutionId: string;
  accountTypeId: string;
  tokenTypeId: string;
}

let fixture: Fixture | null = null;

/** Recent enough that nothing ages out of any lookback window. */
function anchor(): Date {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

async function setupFixture(): Promise<Fixture> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `tr-${randomUUID().slice(0, 8)}@scani.local`, name: 'TransferReviewTest' })
    .returning();
  if (!user) throw new Error('user insert failed');

  const [instType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `tr-${randomUUID().slice(0, 6)}`, name: 'TR Type' })
    .returning();
  if (!instType) throw new Error('instType insert failed');
  const [inst] = await db
    .insert(schema.institutions)
    .values({ name: `TR-${randomUUID().slice(0, 6)}`, typeId: instType.id })
    .returning();
  if (!inst) throw new Error('inst insert failed');
  const [acctType] = await db
    .insert(schema.accountTypes)
    .values({ code: `tr-acct-${randomUUID().slice(0, 6)}`, name: 'TR Account' })
    .returning();
  if (!acctType) throw new Error('acctType insert failed');

  // One wallet, two chains — the shape a bridge needs, written the way the
  // wallet importer writes it (`accounts.metadata`). The `user_wallets` row is
  // what makes an account carrying the pointer actually sync-owned: SC-356's
  // fix reads it, and `SyncWalletBalancesUseCase` refuses an account whose
  // wallet is gone rather than resurrecting it.
  const [userWallet] = await db
    .insert(schema.userWallets)
    .values({
      userId: user.id,
      walletAddress: `0x${randomUUID().replace(/-/g, '')}`,
      institutionIds: [inst.id],
    })
    .returning();
  if (!userWallet) throw new Error('userWallet insert failed');
  const walletId = userWallet.id;
  const [outAccount] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: inst.id,
      typeId: acctType.id,
      name: `exchange-${randomUUID().slice(0, 6)}`,
      metadata: { chainId: '1', userWalletId: walletId },
    })
    .returning();
  const [inAccount] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: inst.id,
      typeId: acctType.id,
      name: `wallet-${randomUUID().slice(0, 6)}`,
    })
    .returning();
  const [emptyAccount] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: inst.id,
      typeId: acctType.id,
      name: `zz-empty-${randomUUID().slice(0, 6)}`,
    })
    .returning();
  const [bridgeAccount] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: inst.id,
      typeId: acctType.id,
      name: `l2-${randomUUID().slice(0, 6)}`,
      metadata: { chainId: '8453', userWalletId: walletId },
    })
    .returning();
  // A wallet the hourly `wallet-balances` sync owns, tracking no position in
  // the token yet — the destination that produced SC-356.
  const [walletSyncedAccount] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: inst.id,
      typeId: acctType.id,
      name: `zz-synced-wallet-${randomUUID().slice(0, 6)}`,
      metadata: { chainId: '1', userWalletId: walletId },
    })
    .returning();
  // The exchange half of the same shape. It needs its OWN institution: the
  // credential is per (user, institution), so hanging one off `inst` would
  // make every other account in this fixture sync-owned too.
  const [exchangeInst] = await db
    .insert(schema.institutions)
    .values({ name: `TRX-${randomUUID().slice(0, 6)}`, typeId: instType.id })
    .returning();
  if (!exchangeInst) throw new Error('exchangeInst insert failed');
  await db.insert(schema.userIntegrationCredentials).values({
    userId: user.id,
    institutionId: exchangeInst.id,
    encryptedCredentials: { ciphertext: 'x' },
    credentialsType: 'api_key',
  });
  const [exchangeSyncedAccount] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: exchangeInst.id,
      typeId: acctType.id,
      name: `zz-synced-cex-${randomUUID().slice(0, 6)}`,
    })
    .returning();
  if (
    !outAccount ||
    !inAccount ||
    !emptyAccount ||
    !bridgeAccount ||
    !walletSyncedAccount ||
    !exchangeSyncedAccount
  ) {
    throw new Error('account insert failed');
  }

  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `tr-tok-${randomUUID().slice(0, 6)}`, name: 'TR Token Type' })
    .returning();
  if (!tokenType) throw new Error('tokenType insert failed');
  const canonicalKey = `tr-asset-${randomUUID().slice(0, 8)}`;
  const [token] = await db
    .insert(schema.tokens)
    .values({
      symbol: `TR${randomUUID().toUpperCase()}`,
      name: 'TR Token',
      typeId: tokenType.id,
      providerMetadata: { coingecko: { id: canonicalKey } },
    })
    .returning();
  if (!token) throw new Error('token insert failed');
  // The same asset, second chain, second row — and a DIFFERENT symbol, so
  // nothing here can pass by symbol equality.
  const [bridgeToken] = await db
    .insert(schema.tokens)
    .values({
      symbol: `BR${randomUUID().toUpperCase()}`,
      name: 'TR Token (L2)',
      typeId: tokenType.id,
      providerMetadata: { coingecko: { id: canonicalKey } },
    })
    .returning();
  if (!bridgeToken) throw new Error('bridgeToken insert failed');

  const [outHolding] = await db
    .insert(schema.holdings)
    .values({ userId: user.id, accountId: outAccount.id, tokenId: token.id, balance: '0' })
    .returning();
  const [inHolding] = await db
    .insert(schema.holdings)
    .values({
      userId: user.id,
      accountId: inAccount.id,
      tokenId: token.id,
      balance: '1',
      source: 'manual',
    })
    .returning();
  // The destination in the reported case: a manually-maintained holding whose
  // balance ALREADY includes the money that moved, because the user raised it
  // by hand when it landed. 6500.32 is the production figure.
  const [sameAccountHolding] = await db
    .insert(schema.holdings)
    .values({
      userId: user.id,
      accountId: outAccount.id,
      tokenId: token.id,
      balance: '6500.32',
      source: 'manual',
    })
    .returning();
  const [bridgeHolding] = await db
    .insert(schema.holdings)
    .values({
      userId: user.id,
      accountId: bridgeAccount.id,
      tokenId: bridgeToken.id,
      balance: '0',
    })
    .returning();
  if (!outHolding || !inHolding || !sameAccountHolding || !bridgeHolding) {
    throw new Error('holding insert failed');
  }

  return {
    userId: user.id,
    tokenId: token.id,
    outHoldingId: outHolding.id,
    inHoldingId: inHolding.id,
    sameAccountHoldingId: sameAccountHolding.id,
    outAccountId: outAccount.id,
    inAccountId: inAccount.id,
    emptyAccountId: emptyAccount.id,
    walletSyncedAccountId: walletSyncedAccount.id,
    exchangeSyncedAccountId: exchangeSyncedAccount.id,
    bridgeTokenId: bridgeToken.id,
    bridgeHoldingId: bridgeHolding.id,
    institutionTypeId: instType.id,
    institutionId: inst.id,
    exchangeInstitutionId: exchangeInst.id,
    accountTypeId: acctType.id,
    tokenTypeId: tokenType.id,
  };
}

async function cleanupFixture(f: Fixture): Promise<void> {
  await db.delete(schema.users).where(eq(schema.users.id, f.userId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, f.tokenId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, f.bridgeTokenId));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, f.exchangeInstitutionId));
  await db
    .delete(schema.institutionTypes)
    .where(eq(schema.institutionTypes.id, f.institutionTypeId));
}

async function insertOutflow(
  f: Fixture,
  opts: {
    at: Date;
    quantity?: string;
    externalId: string;
    kind?: string;
    transferGroupId?: string;
    transferReview?: string;
    counterparty?: string;
    /** Stamped only by the queue. Leaving it unset is the production bulk-pass
     *  shape — answered, with no record of anyone answering it (SC-241). */
    transferReviewedAt?: Date;
    transferReviewSource?: string;
    rawPayload?: Record<string, unknown>;
    createdAt?: Date;
    updatedAt?: Date;
  }
): Promise<string> {
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: f.userId,
      holdingId: f.outHoldingId,
      tokenId: f.tokenId,
      kind: opts.kind ?? 'withdraw',
      quantity: opts.quantity ?? '-1.0',
      occurredAt: opts.at,
      source: 'kraken-api',
      externalId: opts.externalId,
      ...(opts.transferGroupId ? { transferGroupId: opts.transferGroupId } : {}),
      ...(opts.transferReview ? { transferReview: opts.transferReview } : {}),
      ...(opts.counterparty ? { counterparty: opts.counterparty } : {}),
      ...(opts.transferReviewedAt ? { transferReviewedAt: opts.transferReviewedAt } : {}),
      ...(opts.transferReviewSource ? { transferReviewSource: opts.transferReviewSource } : {}),
      ...(opts.rawPayload ? { rawPayload: opts.rawPayload } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
    })
    .returning();
  if (!row) throw new Error('outflow insert failed');
  return row.id;
}

async function insertInflow(
  f: Fixture,
  opts: { at: Date; quantity: string; externalId: string; transferGroupId?: string }
): Promise<string> {
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: f.userId,
      holdingId: f.inHoldingId,
      tokenId: f.tokenId,
      kind: 'deposit',
      quantity: opts.quantity,
      occurredAt: opts.at,
      source: 'etherscan',
      externalId: opts.externalId,
      ...(opts.transferGroupId ? { transferGroupId: opts.transferGroupId } : {}),
    })
    .returning();
  if (!row) throw new Error('inflow insert failed');
  return row.id;
}

/** The arrival half of a bridge: the same asset, the other chain (SC-336). */
async function insertBridgeArrival(
  f: Fixture,
  opts: { at: Date; quantity: string; externalId: string; transferGroupId?: string }
): Promise<string> {
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: f.userId,
      holdingId: f.bridgeHoldingId,
      tokenId: f.bridgeTokenId,
      kind: 'transfer_in',
      quantity: opts.quantity,
      occurredAt: opts.at,
      source: 'etherscan',
      externalId: opts.externalId,
      ...(opts.transferGroupId ? { transferGroupId: opts.transferGroupId } : {}),
    })
    .returning();
  if (!row) throw new Error('bridge arrival insert failed');
  return row.id;
}

/**
 * A real instance, constructed directly rather than pulled from the container.
 *
 * `ReviewFeedService.test.ts` stubs `TransferReviewService` on the container to
 * isolate the feed's own collector, and a `Container.set` is permanent for the
 * process — so `Container.get` here returns that stub whenever the two files
 * share a `bun test` run. In isolation the tests passed and in the suite they
 * failed with "listPending is not a function", which is the same trap the DI
 * note in CLAUDE.md describes from the other direction.
 *
 * Constructing it runs the class-field initialisers against whatever the
 * container holds for its own dependencies, which is what we want: these tests
 * exercise the real SQL.
 */
function service(): TransferReviewService {
  return new TransferReviewService();
}

beforeEach(async () => {
  fixture = await setupFixture();
});

afterEach(async () => {
  if (fixture) await cleanupFixture(fixture);
  fixture = null;
});

describe('TransferReviewService — the queue', () => {
  test('is empty when there is nothing to answer', async () => {
    const f = fixture!;
    expect(await service().listPending(f.userId)).toEqual([]);
    expect((await service().pendingSummary(f.userId)).count).toBe(0);
  });

  test('holds an unpaired outflow, and drops it once a group id is set', async () => {
    const f = fixture!;
    await insertOutflow(f, { at: anchor(), externalId: 'q-1' });
    expect((await service().pendingSummary(f.userId)).count).toBe(1);

    await db
      .update(schema.holdingTransactions)
      .set({ transferGroupId: randomUUID() })
      .where(eq(schema.holdingTransactions.userId, f.userId));
    expect((await service().pendingSummary(f.userId)).count).toBe(0);
  });

  test('excludes an outflow a human has already answered', async () => {
    const f = fixture!;
    await insertOutflow(f, { at: anchor(), externalId: 'q-2', transferReview: 'untracked' });
    expect((await service().pendingSummary(f.userId)).count).toBe(0);
  });

  test('ignores inflows entirely — only an outflow can be a question', async () => {
    const f = fixture!;
    await insertInflow(f, { at: anchor(), quantity: '1.0', externalId: 'q-3' });
    expect((await service().pendingSummary(f.userId)).count).toBe(0);
  });
});

describe('TransferReviewService — candidates', () => {
  test('labels a same-window same-amount deposit as ambiguous only when another matches too', async () => {
    const f = fixture!;
    const at = anchor();
    await insertOutflow(f, { at, externalId: 'c-1' });
    await insertInflow(f, {
      at: new Date(at.getTime() + 5 * 60_000),
      quantity: '0.999',
      externalId: 'c-in-1',
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.candidates).toHaveLength(1);
    // One viable candidate. The matcher would have taken it — which is why it
    // is marked `withinStrictTolerance` — and the only reason this row is in
    // the queue at all in a real system is that the matcher had not yet run.
    expect(item?.candidates[0]?.withinStrictTolerance).toBe(true);
    expect(item?.candidates[0]?.reason).toBe('ambiguous');
  });

  test('explains a deposit that is the right amount but hours late', async () => {
    const f = fixture!;
    const at = anchor();
    await insertOutflow(f, { at, externalId: 'c-2' });
    await insertInflow(f, {
      at: new Date(at.getTime() + 4 * 60 * 60_000),
      quantity: '1.0',
      externalId: 'c-in-2',
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.candidates[0]?.reason).toBe('time_outside_window');
    expect(item?.candidates[0]?.withinStrictTolerance).toBe(false);
    // Signed: the deposit landed after the withdrawal.
    expect(item?.candidates[0]?.timeDeltaMs).toBeGreaterThan(0);
  });

  test('explains a deposit that is on time but outside the fee tolerance', async () => {
    const f = fixture!;
    const at = anchor();
    await insertOutflow(f, { at, externalId: 'c-3' });
    await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '0.95',
      externalId: 'c-in-3',
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.candidates[0]?.reason).toBe('quantity_outside_tolerance');
    // 5% smaller than the outflow — negative, which is the ordinary
    // fee-shaped direction.
    expect(item?.candidates[0]?.quantityDeltaPct).toBeCloseTo(-5, 3);
  });

  test('does not offer a deposit whose amount is nowhere near, even in the window', async () => {
    const f = fixture!;
    const at = anchor();
    await insertOutflow(f, { at, externalId: 'c-4' });
    await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '0.4',
      externalId: 'c-in-4',
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.candidates).toEqual([]);
  });

  test('does not offer a deposit already paired to something else', async () => {
    const f = fixture!;
    const at = anchor();
    await insertOutflow(f, { at, externalId: 'c-5' });
    await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '1.0',
      externalId: 'c-in-5',
      transferGroupId: randomUUID(),
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.candidates).toEqual([]);
  });

  test('ranks the candidate the matcher would have taken above the near misses', async () => {
    const f = fixture!;
    const at = anchor();
    await insertOutflow(f, { at, externalId: 'c-6' });
    await insertInflow(f, {
      at: new Date(at.getTime() + 3 * 60 * 60_000),
      quantity: '1.0',
      externalId: 'c-in-6a',
    });
    await insertInflow(f, {
      at: new Date(at.getTime() + 2 * 60_000),
      quantity: '0.998',
      externalId: 'c-in-6b',
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.candidates[0]?.reason).toBe('ambiguous');
    expect(item?.candidates[1]?.reason).toBe('time_outside_window');
  });
});

/**
 * SC-336. The queue's job is to explain what the matcher refused, so it has to
 * be able to SHOW the other leg of a bridge — and until it could, the only
 * answers available for a bridged outflow were wrong ones. Production has four
 * bridges answered `left_control` with a timestamp on 2026-08-17, i.e. answered
 * by someone who was shown no arrival to pair them with.
 */
describe('TransferReviewService — a bridge', () => {
  test('offers the arrival on the other chain as a candidate', async () => {
    const f = fixture!;
    const at = anchor();
    await insertOutflow(f, { at, externalId: 'br-1', kind: 'transfer_out' });
    await insertBridgeArrival(f, {
      at: new Date(at.getTime() + 6_000),
      quantity: '0.9998',
      externalId: 'br-in-1',
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.candidates).toHaveLength(1);
    expect(item?.candidates[0]?.holdingId).toBe(f.bridgeHoldingId);
    // Inside the matcher's own box, so the matcher would have taken it — and
    // does, once the row is not already answered.
    expect(item?.candidates[0]?.withinStrictTolerance).toBe(true);
  });

  test('names the candidate’s OWN symbol, not the withdrawal’s', async () => {
    const f = fixture!;
    const at = anchor();
    await insertOutflow(f, { at, externalId: 'br-2', kind: 'transfer_out' });
    await insertBridgeArrival(f, {
      at: new Date(at.getTime() + 6_000),
      quantity: '0.9998',
      externalId: 'br-in-2',
    });

    const [item] = await service().listPending(f.userId);
    const [bridgeToken] = await db
      .select({ symbol: schema.tokens.symbol })
      .from(schema.tokens)
      .where(eq(schema.tokens.id, f.bridgeTokenId));
    expect(item?.candidates[0]?.tokenSymbol).toBe(bridgeToken?.symbol ?? '');
    expect(item?.candidates[0]?.tokenSymbol).not.toBe(item?.tokenSymbol);
  });

  test('does not offer an arrival that landed before the money left', async () => {
    const f = fixture!;
    const at = anchor();
    await insertOutflow(f, { at, externalId: 'br-3', kind: 'transfer_out' });
    await insertBridgeArrival(f, {
      at: new Date(at.getTime() - 6 * 60_000),
      quantity: '1.0',
      externalId: 'br-in-3',
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.candidates).toHaveLength(0);
  });

  test('pairs an outflow to the arrival on the other chain, and writes both legs', async () => {
    const f = fixture!;
    const at = anchor();
    const outflowId = await insertOutflow(f, { at, externalId: 'br-4', kind: 'transfer_out' });
    const arrivalId = await insertBridgeArrival(f, {
      at: new Date(at.getTime() + 6_000),
      quantity: '0.9998',
      externalId: 'br-in-4',
    });

    const result = await service().resolve(f.userId, outflowId, 'paired', {
      matchTransactionId: arrivalId,
    });
    expect(result.ok).toBe(true);

    const rows = await db
      .select({
        id: schema.holdingTransactions.id,
        groupId: schema.holdingTransactions.transferGroupId,
      })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    const groups = new Set(rows.map((r) => r.groupId));
    expect(groups.size).toBe(1);
    expect([...groups][0]).not.toBeNull();
  });

  test('refuses to pair an outflow with a different asset on another chain', async () => {
    const f = fixture!;
    const at = anchor();
    const outflowId = await insertOutflow(f, { at, externalId: 'br-5', kind: 'transfer_out' });
    // Strip the L2 row's canonical key: now it is only a token with a similar
    // amount on another chain, which is not evidence of anything.
    await db
      .update(schema.tokens)
      .set({ providerMetadata: {} })
      .where(eq(schema.tokens.id, f.bridgeTokenId));
    const arrivalId = await insertBridgeArrival(f, {
      at: new Date(at.getTime() + 6_000),
      quantity: '0.9998',
      externalId: 'br-in-5',
    });

    const result = await service().resolve(f.userId, outflowId, 'paired', {
      matchTransactionId: arrivalId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('partner_gone');

    const rows = await db
      .select({ groupId: schema.holdingTransactions.transferGroupId })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    expect(rows.every((r) => r.groupId === null)).toBe(true);
  });
});

/**
 * SC-354. Reopening an answer is only a repair if the queue can then answer it;
 * otherwise the reader is asked the same unanswerable question and gives the
 * same wrong answer, having done the work twice. `listAnswered` carries no
 * candidates by design, so before this there was no way to ask in advance.
 *
 * The second test is the one that stopped a bad repair. Four production bridges
 * answered `left_control` at 08:31 on 2026-08-17 have an arrival held inside a
 * SAME-HOLDING transfer group (SC-347, open), and both this preview and the
 * matcher exclude an already-grouped inflow — so reopening those four would put
 * them in a queue with nothing to pair them to. They were left answered.
 */
describe('TransferReviewService — previewing a reopen', () => {
  test('offers the cross-chain arrival for a bridge already answered left_control', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, externalId: 'rp-1', kind: 'transfer_out' });
    await insertBridgeArrival(f, {
      at: new Date(at.getTime() + 6_000),
      quantity: '0.9998',
      externalId: 'rp-in-1',
    });
    await service().resolve(f.userId, outId, 'left_control');

    const candidates = await service().reopenPreview(f.userId, outId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.holdingId).toBe(f.bridgeHoldingId);
    expect(candidates[0]?.withinStrictTolerance).toBe(true);
  });

  test('offers NOTHING when the arrival is already held by a transfer group', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, externalId: 'rp-2', kind: 'transfer_out' });
    await insertBridgeArrival(f, {
      at: new Date(at.getTime() + 6_000),
      quantity: '0.9998',
      externalId: 'rp-in-2',
      transferGroupId: randomUUID(),
    });
    await service().resolve(f.userId, outId, 'left_control');

    expect(await service().reopenPreview(f.userId, outId)).toHaveLength(0);
  });

  test('offers nothing for a row that carries no answer', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, externalId: 'rp-3', kind: 'transfer_out' });
    await insertBridgeArrival(f, {
      at: new Date(at.getTime() + 6_000),
      quantity: '0.9998',
      externalId: 'rp-in-3',
    });

    expect(await service().reopenPreview(f.userId, outId)).toHaveLength(0);
  });

  test('will not preview another user’s row', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, externalId: 'rp-4', kind: 'transfer_out' });
    await insertBridgeArrival(f, {
      at: new Date(at.getTime() + 6_000),
      quantity: '0.9998',
      externalId: 'rp-in-4',
    });
    await service().resolve(f.userId, outId, 'left_control');

    expect(await service().reopenPreview(randomUUID(), outId)).toHaveLength(0);
  });
});

describe('TransferReviewService — answers', () => {
  test('pairing writes one group id across both legs and stamps the decision', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, externalId: 'a-1' });
    const inId = await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '1.0',
      externalId: 'a-in-1',
    });

    expect(
      await service().resolve(f.userId, outId, 'paired', { matchTransactionId: inId })
    ).toEqual({
      ok: true,
    });

    const rows = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    const out = rows.find((r) => r.id === outId);
    const inflow = rows.find((r) => r.id === inId);
    expect(out?.transferGroupId).toBeTruthy();
    expect(inflow?.transferGroupId).toBe(out?.transferGroupId ?? null);
    expect(out?.transferReview).toBe('paired');
    expect(out?.transferReviewedAt).toBeTruthy();
    // The inflow is *linked*, not *reviewed*: the question was asked about the
    // withdrawal, and stamping the deposit too would claim someone answered a
    // question that was never put to them.
    expect(inflow?.transferReview).toBeNull();
    expect((await service().pendingSummary(f.userId)).count).toBe(0);
  });

  test('a disposal and an untracked move both leave the queue without a group id', async () => {
    const f = fixture!;
    const leftId = await insertOutflow(f, { at: anchor(), externalId: 'a-2' });
    const goneId = await insertOutflow(f, { at: anchor(), externalId: 'a-3' });

    expect(await service().resolve(f.userId, leftId, 'left_control')).toEqual({ ok: true });
    expect(await service().resolve(f.userId, goneId, 'untracked')).toEqual({ ok: true });

    const rows = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    expect(rows.find((r) => r.id === leftId)?.transferReview).toBe('left_control');
    expect(rows.find((r) => r.id === goneId)?.transferReview).toBe('untracked');
    expect(rows.every((r) => r.transferGroupId === null)).toBe(true);
    expect((await service().pendingSummary(f.userId)).count).toBe(0);
  });

  test('answering the same row twice is a no-op, not a second write', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), externalId: 'a-4' });
    expect(await service().resolve(f.userId, outId, 'untracked')).toEqual({ ok: true });
    expect(await service().resolve(f.userId, outId, 'left_control')).toEqual({
      ok: false,
      reason: 'gone',
    });

    const [row] = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, outId));
    expect(row?.transferReview).toBe('untracked');
  });

  test('refuses to pair with a deposit that was claimed in the meantime', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, externalId: 'a-5' });
    const inId = await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '1.0',
      externalId: 'a-in-5',
      transferGroupId: randomUUID(),
    });

    expect(
      await service().resolve(f.userId, outId, 'paired', { matchTransactionId: inId })
    ).toEqual({
      ok: false,
      reason: 'partner_gone',
    });

    // And crucially: the outflow is untouched, still in the queue. A refused
    // pairing that half-applied would leave a group id pointing at nothing.
    const [row] = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, outId));
    expect(row?.transferGroupId).toBeNull();
    expect(row?.transferReview).toBeNull();
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('will not answer another user’s transfer', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), externalId: 'a-6' });
    expect(await service().resolve(randomUUID(), outId, 'untracked')).toEqual({
      ok: false,
      reason: 'gone',
    });
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('reopening a pairing clears the group id from BOTH legs', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, externalId: 'a-7' });
    const inId = await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '1.0',
      externalId: 'a-in-7',
    });
    await service().resolve(f.userId, outId, 'paired', { matchTransactionId: inId });

    expect(await service().reopen(f.userId, outId)).toBe(true);

    const rows = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    expect(rows.every((r) => r.transferGroupId === null)).toBe(true);
    expect(rows.find((r) => r.id === outId)?.transferReview).toBeNull();
    expect(rows.find((r) => r.id === outId)?.transferReviewedAt).toBeNull();
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('reopening something nobody answered is a no-op', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), externalId: 'a-8' });
    expect(await service().reopen(f.userId, outId)).toBe(false);
  });

  test('a "paired" decision with no partner is a programming error, not a silent write', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), externalId: 'a-9' });
    await expect(service().resolve(f.userId, outId, 'paired')).rejects.toThrow(
      /requires matchTransactionId/
    );
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });
});

/**
 * Answering PART of a transfer (SC-181).
 *
 * The reported case is the first test verbatim: a 4,000 USD Airwallex
 * withdrawal of which 3,500 moved to an untracked account and 500 genuinely
 * left. Every SC-150 answer is about the whole row, so before this the only
 * options were to overstate the realized gain by 3,500 or understate it by
 * 500 — wrong in a direction either way.
 */
describe('TransferReviewService — a divided answer', () => {
  test('records the reported 3,500 untracked / 500 disposed division', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, {
      at: anchor(),
      quantity: '-4000',
      externalId: 's-1',
    });

    const result = await service().resolveSplit(f.userId, outId, [
      { decision: 'untracked', quantity: '3500' },
      { decision: 'left_control', quantity: '500' },
    ]);

    expect(result).toEqual({ ok: true });
    const [row] = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, outId));
    expect(row?.transferReview).toBe('split');
    expect(row?.transferReviewSplit).toEqual([
      { decision: 'untracked', quantity: '3500' },
      { decision: 'left_control', quantity: '500' },
    ]);
    expect(row?.transferReviewedAt).not.toBeNull();
  });

  test('a split leaves the queue — the count still reaches zero', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 's-2' });
    expect((await service().pendingSummary(f.userId)).count).toBe(1);

    await service().resolveSplit(f.userId, outId, [
      { decision: 'untracked', quantity: '60' },
      { decision: 'left_control', quantity: '40' },
    ]);

    expect((await service().pendingSummary(f.userId)).count).toBe(0);
  });

  test('refuses parts that do not add up, and says what they should add up to', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-4000', externalId: 's-3' });

    const short = await service().resolveSplit(f.userId, outId, [
      { decision: 'untracked', quantity: '3500' },
      { decision: 'left_control', quantity: '400' },
    ]);
    expect(short).toEqual({ ok: false, reason: 'sum', expected: '4000' });

    const over = await service().resolveSplit(f.userId, outId, [
      { decision: 'untracked', quantity: '3500' },
      { decision: 'left_control', quantity: '600' },
    ]);
    expect(over).toEqual({ ok: false, reason: 'sum', expected: '4000' });

    // Nothing was written by either attempt — the row is still a question.
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('rejects a one-part "split", which is a whole answer wearing a list', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 's-4' });
    const result = await service().resolveSplit(f.userId, outId, [
      { decision: 'untracked', quantity: '100' },
    ]);
    expect(result.ok).toBe(false);
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('rejects the same outcome twice', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 's-5' });
    const result = await service().resolveSplit(f.userId, outId, [
      { decision: 'untracked', quantity: '60' },
      { decision: 'untracked', quantity: '40' },
    ]);
    expect(result.ok).toBe(false);
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('a paired part links its deposit and writes the group id on both legs', async () => {
    const f = fixture!;
    const at = anchor();
    // The fee-shaped case: 4,000 left, 3,500 arrived, 500 was the fee. The
    // matcher refuses it at 12.5% outside its ±1%, and neither whole answer is
    // true of it.
    const outId = await insertOutflow(f, { at, quantity: '-4000', externalId: 's-6' });
    const inId = await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '3500',
      externalId: 's-in-6',
    });

    const result = await service().resolveSplit(f.userId, outId, [
      { decision: 'paired', quantity: '3500', matchTransactionId: inId },
      { decision: 'left_control', quantity: '500' },
    ]);

    expect(result).toEqual({ ok: true });
    const rows = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    const out = rows.find((r) => r.id === outId);
    const inflow = rows.find((r) => r.id === inId);
    expect(out?.transferGroupId).not.toBeNull();
    expect(inflow?.transferGroupId).toBe(out?.transferGroupId ?? '');
    expect(out?.transferReview).toBe('split');
  });

  test('refuses a paired part whose deposit was claimed in the meantime', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, quantity: '-4000', externalId: 's-7' });
    const inId = await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '3500',
      externalId: 's-in-7',
      transferGroupId: randomUUID(),
    });

    const result = await service().resolveSplit(f.userId, outId, [
      { decision: 'paired', quantity: '3500', matchTransactionId: inId },
      { decision: 'left_control', quantity: '500' },
    ]);

    expect(result).toEqual({ ok: false, reason: 'partner_gone' });
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('a split is reversible — reopening clears the parts and both group ids', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, quantity: '-4000', externalId: 's-8' });
    const inId = await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '3500',
      externalId: 's-in-8',
    });
    await service().resolveSplit(f.userId, outId, [
      { decision: 'paired', quantity: '3500', matchTransactionId: inId },
      { decision: 'untracked', quantity: '500' },
    ]);

    expect(await service().reopen(f.userId, outId)).toBe(true);

    const rows = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    const out = rows.find((r) => r.id === outId);
    expect(out?.transferReview).toBeNull();
    expect(out?.transferReviewSplit).toBeNull();
    expect(rows.every((r) => r.transferGroupId === null)).toBe(true);
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('answering whole after a split clears the division', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 's-9' });
    await service().resolveSplit(f.userId, outId, [
      { decision: 'untracked', quantity: '60' },
      { decision: 'left_control', quantity: '40' },
    ]);
    await service().reopen(f.userId, outId);
    expect(await service().resolve(f.userId, outId, 'left_control')).toEqual({ ok: true });

    const [row] = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, outId));
    expect(row?.transferReview).toBe('left_control');
    expect(row?.transferReviewSplit).toBeNull();
  });

  test('will not divide another user’s transfer', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 's-10' });
    const result = await service().resolveSplit(randomUUID(), outId, [
      { decision: 'untracked', quantity: '60' },
      { decision: 'left_control', quantity: '40' },
    ]);
    expect(result).toEqual({ ok: false, reason: 'gone' });
  });
});

/**
 * The route back to an answer already given (SC-181).
 *
 * 573 transfers were answered `left_control` in one bulk pass before an answer
 * could apply to part of a transaction, so a list that only ever shows
 * unanswered rows leaves the reported withdrawal unreachable.
 */
describe('TransferReviewService — answered transfers', () => {
  test('lists answered outflows and never unanswered ones', async () => {
    const f = fixture!;
    const answeredId = await insertOutflow(f, {
      at: anchor(),
      externalId: 'an-1',
      transferReview: 'left_control',
    });
    await insertOutflow(f, { at: anchor(), externalId: 'an-2' });

    const { items } = await service().listAnswered(f.userId);
    expect(items.map((r) => r.transactionId)).toEqual([answeredId]);
    expect(items[0]?.decision).toBe('left_control');
    expect(items[0]?.split).toBeNull();
  });

  test('carries the parts of a divided answer', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-4000', externalId: 'an-3' });
    await service().resolveSplit(f.userId, outId, [
      { decision: 'untracked', quantity: '3500' },
      { decision: 'left_control', quantity: '500' },
    ]);

    const { items } = await service().listAnswered(f.userId);
    expect(items).toHaveLength(1);
    expect(items[0]?.decision).toBe('split');
    expect(items[0]?.split).toEqual([
      { decision: 'untracked', quantity: '3500' },
      { decision: 'left_control', quantity: '500' },
    ]);
    expect(items[0]?.quantity).toBe('4000');
  });

  test('is nobody else’s list', async () => {
    const f = fixture!;
    await insertOutflow(f, { at: anchor(), externalId: 'an-4', transferReview: 'untracked' });
    expect((await service().listAnswered(randomUUID())).items).toEqual([]);
  });
});

/**
 * The ordering and the paging (SC-241).
 *
 * Every fixture here has rows with **no** `transfer_reviewed_at`, because that
 * is the whole defect and it is invisible to a fixture where each row is
 * stamped: ordering by a stamped column is correct right up until the column is
 * NULL, and then Postgres sorts NULLS FIRST under DESC and the limit cuts the
 * list before a single real answer. In production that was 573 undated rows
 * burying all 6 dated ones, on the one surface built to reach them.
 */
describe('TransferReviewService — the answered list is reachable', () => {
  /** The bulk-pass shape: answered, with nothing recording who answered. */
  async function insertBulkPassed(f: Fixture, externalId: string, at: Date): Promise<string> {
    return insertOutflow(f, {
      at: anchor(),
      externalId,
      transferReview: 'left_control',
      createdAt: at,
      updatedAt: at,
    });
  }

  test('an answer a person gave is not buried under answers nobody gave', async () => {
    const f = fixture!;
    const day = (n: number) => new Date(Date.UTC(2026, 4, n));

    // Three undated rows, then the one a person actually answered. Under
    // `desc(transferReviewedAt)` the three NULLs sort FIRST and fill a page of
    // three, so `humanId` is absent — not last, absent.
    await insertBulkPassed(f, 'ord-1', day(17));
    await insertBulkPassed(f, 'ord-2', day(18));
    await insertBulkPassed(f, 'ord-3', day(19));
    const humanId = await insertOutflow(f, {
      at: anchor(),
      externalId: 'ord-human',
      transferReview: 'left_control',
      transferReviewedAt: day(20),
      createdAt: day(16),
      updatedAt: day(16),
    });

    const { items } = await service().listAnswered(f.userId, { limit: 3 });
    expect(items.map((r) => r.transactionId)).toContain(humanId);
    expect(items[0]?.transactionId).toBe(humanId);
  });

  test('every answered row is reachable by paging, none twice', async () => {
    const f = fixture!;
    // One timestamp for all five, so the sort key alone cannot order them. A
    // keyset cursor over a non-unique key skips and repeats rows; `id` is what
    // stops that, and it is the same defect SC-193 was.
    const sameInstant = new Date(Date.UTC(2026, 4, 17, 12));
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      ids.add(await insertBulkPassed(f, `page-${i}`, sameInstant));
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await service().listAnswered(f.userId, { limit: 2, cursor });
      seen.push(...page.items.map((r) => r.transactionId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(ids);
  });

  test('the last page says so rather than offering another', async () => {
    const f = fixture!;
    await insertBulkPassed(f, 'last-1', new Date(Date.UTC(2026, 4, 17)));
    await insertBulkPassed(f, 'last-2', new Date(Date.UTC(2026, 4, 18)));

    const first = await service().listAnswered(f.userId, { limit: 1 });
    expect(first.nextCursor).not.toBeNull();

    const second = await service().listAnswered(f.userId, {
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  test('says which answers are the reader’s own and which are unattributed', async () => {
    const f = fixture!;
    const bulkId = await insertBulkPassed(f, 'src-bulk', new Date(Date.UTC(2026, 4, 17)));
    const outId = await insertOutflow(f, { at: anchor(), externalId: 'src-own' });
    await service().resolve(f.userId, outId, 'untracked');

    const { items } = await service().listAnswered(f.userId);
    const bySource = new Map(items.map((r) => [r.transactionId, r]));
    expect(bySource.get(outId)?.answerSource).toBe('user');
    expect(bySource.get(outId)?.reviewedAt).not.toBeNull();
    expect(bySource.get(bulkId)?.answerSource).toBe('unattributed');
    expect(bySource.get(bulkId)?.reviewedAt).toBeNull();
  });

  test('a cursor it cannot read is refused, not treated as page one', async () => {
    const f = fixture!;
    await insertBulkPassed(f, 'bad-cursor', new Date(Date.UTC(2026, 4, 17)));

    expect(service().listAnswered(f.userId, { cursor: 'not-a-cursor' })).rejects.toThrow(
      MalformedCursorError
    );
  });

  /**
   * SC-244. The search moved here because the surface's own version could only
   * see the page it had fetched, and reported the result in the words it uses
   * for a reader who has answered nothing.
   */
  describe('the search reads every row, not the page', () => {
    /** The ticket's shape: the match is on page TWO and the reader is on one. */
    test('finds a row past the first page', async () => {
      const f = fixture!;
      const day = (n: number) => new Date(Date.UTC(2026, 4, n));
      for (let i = 0; i < 5; i++) await insertBulkPassed(f, `noise-${i}`, day(20 - i));
      await insertOutflow(f, {
        at: anchor(),
        externalId: 'revolut-one',
        transferReview: 'left_control',
        counterparty: 'Revolut Ltd',
        createdAt: day(10),
        updatedAt: day(10),
      });

      // Unsearched, a page of two cannot reach it.
      const page = await service().listAnswered(f.userId, { limit: 2 });
      expect(page.items.map((r) => r.counterparty)).not.toContain('Revolut Ltd');

      const found = await service().listAnswered(f.userId, { limit: 2, search: 'revolut' });
      expect(found.items).toHaveLength(1);
      expect(found.items[0]?.counterparty).toBe('Revolut Ltd');
      // And the reply does not offer a page that does not exist.
      expect(found.nextCursor).toBeNull();
    });

    test('matches a fragment, in any case', async () => {
      const f = fixture!;
      await insertOutflow(f, {
        at: anchor(),
        externalId: 'case-1',
        transferReview: 'left_control',
        counterparty: 'Revolut Ltd',
      });
      expect((await service().listAnswered(f.userId, { search: 'VOLUT' })).items).toHaveLength(1);
      expect((await service().listAnswered(f.userId, { search: 'monzo' })).items).toHaveLength(0);
    });

    /**
     * The four fields are CONCATENATED rather than ORed, for the reason the
     * surface joined them: one term the reader expects to match one row across
     * two columns. Four ORed predicates would match neither row here, and no
     * predicate at all would match both — so this pins the concatenation
     * specifically, not merely "a search happens".
     */
    test('matches across the columns, the way the surface used to', async () => {
      const f = fixture!;
      const [institution] = await db
        .select({ name: schema.institutions.name })
        .from(schema.institutions)
        .where(eq(schema.institutions.id, f.institutionId));
      await insertOutflow(f, {
        at: anchor(),
        externalId: 'across-hit',
        transferReview: 'left_control',
        counterparty: 'Revolut Ltd',
      });
      await insertBulkPassed(f, 'across-miss', new Date(Date.UTC(2026, 4, 17)));

      // Spans the institution/counterparty boundary — contiguous only in the
      // concatenation, and only for the row that has a counterparty.
      const spanning = `${institution?.name} Revolut`;
      const found = await service().listAnswered(f.userId, { search: spanning });
      expect(found.items).toHaveLength(1);
      expect(found.items[0]?.counterparty).toBe('Revolut Ltd');
    });

    /**
     * A negative control on `ilikePattern`. Unescaped, `%` is the pattern that
     * matches every row — so a reader who typed one would be handed their whole
     * list back as if it were a result.
     */
    test('a wildcard the reader typed is a character, not a wildcard', async () => {
      const f = fixture!;
      await insertBulkPassed(f, 'wild-1', new Date(Date.UTC(2026, 4, 17)));
      expect((await service().listAnswered(f.userId, { search: '%' })).items).toHaveLength(0);
      expect((await service().listAnswered(f.userId, { search: '_' })).items).toHaveLength(0);
    });

    test('an empty or blank term is not a search at all', async () => {
      const f = fixture!;
      await insertBulkPassed(f, 'blank-1', new Date(Date.UTC(2026, 4, 17)));
      expect((await service().listAnswered(f.userId, { search: '   ' })).items).toHaveLength(1);
      expect((await service().listAnswered(f.userId, { search: '' })).items).toHaveLength(1);
    });

    test('never reaches another user’s rows', async () => {
      const f = fixture!;
      await insertOutflow(f, {
        at: anchor(),
        externalId: 'tenant-1',
        transferReview: 'left_control',
        counterparty: 'Revolut Ltd',
      });
      expect(
        (await service().listAnswered(randomUUID(), { search: 'revolut' })).items
      ).toHaveLength(0);
    });
  });
});

/**
 * The fourth answer: it moved to a holding Scani tracks (SC-187).
 *
 * The reported case, with the production rows behind it. A 4,000 USD Airwallex
 * withdrawal, of which 3,500 moved to a Revolut savings account the user keeps
 * up to date **by hand** and 500 genuinely left. There is no deposit on
 * Revolut to pair with, and there never was: the account has no importer, so
 * the matcher was not failing to find a counterpart — there was nothing to
 * find. `paired` is unwritable, `untracked` is false, and `left_control` books
 * a gain nobody made.
 *
 * **The double-count risk is real and is now answered by WHO OWNS THE
 * DESTINATION'S BALANCE, not by never moving it** (SC-856). `holdings.balance`
 * is an independent anchor rather than a sum of transactions, so writing the
 * arrival buys cost-basis continuity on its own — and on a destination a sync
 * owns, that sync has already put the money in the balance, so moving it would
 * count it twice. On one nobody syncs there is no such observer: leaving the
 * anchor still recorded the arrival and moved no money, the owner raised the
 * figure by hand, and THAT edit wrote a second arrival. One hand-maintained
 * savings holding was left carrying three arrival rows for one movement.
 *
 * So every test below that writes an inflow asserts the anchor, and which way
 * it asserts is the discriminator: unsynced destinations move, sync-owned ones
 * do not.
 */
describe('TransferReviewService — moved to a holding Scani tracks', () => {
  /** The rows this answer wrote, if any. */
  async function createdInflows(f: Fixture, outflowId: string) {
    return db
      .select()
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, f.userId),
          eq(schema.holdingTransactions.source, 'transfer-review'),
          eq(schema.holdingTransactions.externalId, outflowId)
        )
      );
  }

  async function balanceOf(holdingId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ balance: schema.holdings.balance })
      .from(schema.holdings)
      .where(eq(schema.holdings.id, holdingId));
    return row?.balance;
  }

  async function outflowRow(outflowId: string) {
    const [row] = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, outflowId));
    return row;
  }

  test('writes the arrival, shares the group id, and moves an anchor nobody syncs', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, quantity: '-4000', externalId: 'i-1' });

    expect(
      await service().resolve(f.userId, outId, 'internal', {
        destination: { accountId: f.inAccountId, holdingId: f.inHoldingId },
      })
    ).toEqual({ ok: true });

    const [inflow] = await createdInflows(f, outId);
    expect(inflow?.holdingId).toBe(f.inHoldingId);
    expect(inflow?.quantity).toBe('4000');
    expect(inflow?.kind).toBe('transfer_in');
    // Dated when the money left, because that is the only date anyone knows.
    expect(inflow?.occurredAt.getTime()).toBe(at.getTime());

    // The pair, not a lookalike. Without the shared group id `walkComponent`
    // walks the destination on its own and opens a fresh market-value lot —
    // the invented gain SC-150 closed, arriving by another route.
    const out = await outflowRow(outId);
    expect(out?.transferReview).toBe('internal');
    expect(out?.transferGroupId).not.toBeNull();
    expect(inflow?.transferGroupId).toBe(out?.transferGroupId ?? '');

    // The assertion this whole ticket turns on, in the direction SC-856 turned
    // it. `inHolding` is `source = 'manual'` on an account no balance sync
    // owns, so nothing else will ever put the 4,000 in: leaving the anchor at
    // 1 is what made the owner raise it by hand and write a second arrival.
    expect(await balanceOf(f.inHoldingId)).toBe('4001');

    expect((await service().pendingSummary(f.userId)).count).toBe(0);
  });

  test('as one part of a split, writes the PART’s amount and not the row’s', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, {
      at: anchor(),
      quantity: '-4000',
      externalId: 'i-2',
    });

    expect(
      await service().resolveSplit(f.userId, outId, [
        {
          decision: 'internal',
          quantity: '3500',
          destination: { accountId: f.inAccountId, holdingId: f.inHoldingId },
        },
        { decision: 'left_control', quantity: '500' },
      ])
    ).toEqual({ ok: true });

    const [inflow] = await createdInflows(f, outId);
    // 3,500 arrived. Writing 4,000 would trade an overstated gain for an
    // overstated balance — the same error wearing the other hat.
    expect(inflow?.quantity).toBe('3500');
    // And the anchor moves by the PORTION too, for the same reason — 4,001
    // here would put the 500 that genuinely left into the destination.
    expect(await balanceOf(f.inHoldingId)).toBe('3501');

    const out = await outflowRow(outId);
    expect(out?.transferReview).toBe('split');
    expect(inflow?.transferGroupId).toBe(out?.transferGroupId ?? '');
  });

  test('sends money to a second holding of the same token in the SAME account', async () => {
    // Airwallex has two USD holdings — imported at 1,201.50 and manual at
    // 6,217.15 — and a withdrawal moved between them. An account-level
    // destination could not have expressed this.
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-700', externalId: 'i-3' });

    expect(
      await service().resolve(f.userId, outId, 'internal', {
        destination: { accountId: f.outAccountId, holdingId: f.sameAccountHoldingId },
      })
    ).toEqual({ ok: true });

    const [inflow] = await createdInflows(f, outId);
    expect(inflow?.holdingId).toBe(f.sameAccountHoldingId);
    // Hand-maintained and on an account nobody syncs, so the anchor moves
    // (SC-856). This assertion read 6500.32 until then, on the premise that
    // the owner had ALREADY raised it when the money landed — a premise
    // `writeInflow` cannot check, since a hand edit with no stated cause
    // moves the anchor and writes no row. The queue's answer for an arrival
    // that already exists is `paired`; `internal` means nothing recorded it.
    expect(await balanceOf(f.sameAccountHoldingId)).toBe('7200.32');
  });

  test('creates the holding when the account tracks none, at the amount that moved', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-250', externalId: 'i-4' });

    expect(
      await service().resolve(f.userId, outId, 'internal', {
        destination: { accountId: f.emptyAccountId, holdingId: null },
      })
    ).toEqual({ ok: true });

    const [created] = await db
      .select()
      .from(schema.holdings)
      .where(
        and(
          eq(schema.holdings.userId, f.userId),
          eq(schema.holdings.accountId, f.emptyAccountId),
          eq(schema.holdings.tokenId, f.tokenId)
        )
      );
    expect(created).toBeDefined();
    // Not zero. The money is there and nobody has said otherwise — and a
    // holding at zero holding a 250 deposit would read as 250 short from the
    // day it was made.
    expect(created?.balance).toBe('250');
    // THE SC-187 INVARIANT, and the one SC-356 must not spend to buy its own
    // fix: nothing syncs this account, so the row stays the user's. It is
    // `source = 'manual'` that makes `HoldingsSyncHelper` refuse to touch the
    // balance, and this account is exactly the Revolut-savings destination
    // that protection exists for. Remove the sync-ownership test in
    // `openingOf` and this fails: the row arrives at 0 under a sync's source,
    // handing a hand-maintained balance to a sync that will never fetch it.
    expect(created?.source).toBe('manual');

    const [inflow] = await createdInflows(f, outId);
    expect(inflow?.holdingId).toBe(created?.id ?? '');
  });

  test('refuses a destination that is not the user’s, and writes nothing at all', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 'i-5' });

    expect(
      await service().resolve(f.userId, outId, 'internal', {
        destination: { accountId: randomUUID(), holdingId: randomUUID() },
      })
    ).toEqual({ ok: false, reason: 'destination_gone' });

    expect(await createdInflows(f, outId)).toHaveLength(0);
    // The whole answer is rolled back — the row is still a question.
    expect((await outflowRow(outId))?.transferReview).toBeNull();
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('refuses the holding the money left — that is a no-op, not a destination', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 'i-6' });

    expect(
      await service().resolve(f.userId, outId, 'internal', {
        destination: { accountId: f.outAccountId, holdingId: f.outHoldingId },
      })
    ).toEqual({ ok: false, reason: 'destination_gone' });
    expect(await createdInflows(f, outId)).toHaveLength(0);
  });

  test('reopening deletes the arrival it wrote, on both legs', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-4000', externalId: 'i-7' });
    await service().resolve(f.userId, outId, 'internal', {
      destination: { accountId: f.inAccountId, holdingId: f.inHoldingId },
    });
    expect(await createdInflows(f, outId)).toHaveLength(1);

    expect(await service().reopen(f.userId, outId)).toBe(true);

    // Leaving it behind is how the NEXT answer double-counts: a 4,000 inflow
    // on the destination for a withdrawal now marked as a disposal.
    expect(await createdInflows(f, outId)).toHaveLength(0);
    const out = await outflowRow(outId);
    expect(out?.transferReview).toBeNull();
    expect(out?.transferGroupId).toBeNull();
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('answering differently after a reopen leaves nothing behind', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-4000', externalId: 'i-8' });
    await service().resolve(f.userId, outId, 'internal', {
      destination: { accountId: f.inAccountId, holdingId: f.inHoldingId },
    });
    await service().reopen(f.userId, outId);
    expect(await service().resolve(f.userId, outId, 'left_control')).toEqual({ ok: true });

    expect(await createdInflows(f, outId)).toHaveLength(0);
    expect(await balanceOf(f.inHoldingId)).toBe('1');
  });

  test('re-answering with a different destination moves the arrival, never duplicates it', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-4000', externalId: 'i-9' });
    await service().resolve(f.userId, outId, 'internal', {
      destination: { accountId: f.inAccountId, holdingId: f.inHoldingId },
    });
    await service().reopen(f.userId, outId);
    await service().resolve(f.userId, outId, 'internal', {
      destination: { accountId: f.outAccountId, holdingId: f.sameAccountHoldingId },
    });

    const rows = await createdInflows(f, outId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.holdingId).toBe(f.sameAccountHoldingId);
  });

  test('the written arrival is never offered as a candidate for another transfer', async () => {
    // It carries a group id from the moment it is written, and the candidate
    // search only looks at unclaimed inflows — so it cannot be paired to a
    // second outflow and counted twice.
    const f = fixture!;
    const at = anchor();
    const answeredId = await insertOutflow(f, { at, quantity: '-4000', externalId: 'i-10' });
    await service().resolve(f.userId, answeredId, 'internal', {
      destination: { accountId: f.inAccountId, holdingId: f.inHoldingId },
    });

    await insertOutflow(f, { at, quantity: '-4000', externalId: 'i-11' });
    const [pending] = await service().listPending(f.userId);
    expect(pending?.candidates).toEqual([]);
  });
});

/**
 * SC-356. The holding an `internal` answer creates used to be `manual` at the
 * moved amount on EVERY destination. On a wallet or an exchange that is a
 * balance no sync may correct (`HoldingsSyncHelper` skips manual rows) and a
 * row no sync can find, so the next pass creates a second holding for the same
 * (account, token). Six answers in the SC-350 repair would have opened 4,250
 * USDT across two Ethereum wallets that hold none.
 */
describe('TransferReviewService — who owns the balance of a holding it had to create', () => {
  async function createdInflows(f: Fixture, outflowId: string) {
    return db
      .select()
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, f.userId),
          eq(schema.holdingTransactions.source, 'transfer-review'),
          eq(schema.holdingTransactions.externalId, outflowId)
        )
      );
  }

  async function createdHolding(f: Fixture, accountId: string) {
    const rows = await db
      .select()
      .from(schema.holdings)
      .where(
        and(
          eq(schema.holdings.userId, f.userId),
          eq(schema.holdings.accountId, accountId),
          eq(schema.holdings.tokenId, f.tokenId)
        )
      );
    return rows;
  }

  test('opens a wallet destination as the sync’s own row, at zero', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-1000', externalId: 's356-1' });

    expect(
      await service().resolve(f.userId, outId, 'internal', {
        destination: { accountId: f.walletSyncedAccountId, holdingId: null },
      })
    ).toEqual({ ok: true });

    const rows = await createdHolding(f, f.walletSyncedAccountId);
    expect(rows).toHaveLength(1);
    // Zero, not 1000. The wallet path runs `staleStrategy: 'preserve'`, so a
    // token the chain does not report is never visited — a non-zero opening
    // for a token the wallet does not hold would outlive every future sync
    // even though the row is now the sync's to write.
    expect(rows[0]?.balance).toBe('0');
    expect(rows[0]?.source).toBe('blockchain');
    // A person picked this account in the form. That is what the column says.
    expect(rows[0]?.arrival).toBe('user_confirmed');

    // The arrival is in the ledger either way — that is what carries cost
    // basis across the pair, and it is untouched by the balance decision.
    const [inflow] = await createdInflows(f, outId);
    expect(inflow?.holdingId).toBe(rows[0]?.id ?? '');
    expect(inflow?.quantity).toBe('1000');
  });

  test('opens an exchange destination as the sync’s own row, at zero', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-3250', externalId: 's356-2' });

    expect(
      await service().resolve(f.userId, outId, 'internal', {
        destination: { accountId: f.exchangeSyncedAccountId, holdingId: null },
      })
    ).toEqual({ ok: true });

    const rows = await createdHolding(f, f.exchangeSyncedAccountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.balance).toBe('0');
    expect(rows[0]?.source).toBe('sync_exchange_balances');

    const [inflow] = await createdInflows(f, outId);
    expect(inflow?.quantity).toBe('3250');
  });

  test('a disconnected integration is not a sync — the row stays the user’s', async () => {
    const f = fixture!;
    // `isActive = false` is how `IntegrationCredentialsService.deleteCredentials`
    // disconnects, and the exchange sync filters on it. Nothing will fetch this
    // account again, so a row opened at zero under a sync's source would sit at
    // zero forever with nobody allowed to think it was theirs to fix.
    await db
      .update(schema.userIntegrationCredentials)
      .set({ isActive: false })
      .where(eq(schema.userIntegrationCredentials.institutionId, f.exchangeInstitutionId));

    const outId = await insertOutflow(f, { at: anchor(), quantity: '-77', externalId: 's356-3' });
    expect(
      await service().resolve(f.userId, outId, 'internal', {
        destination: { accountId: f.exchangeSyncedAccountId, holdingId: null },
      })
    ).toEqual({ ok: true });

    const rows = await createdHolding(f, f.exchangeSyncedAccountId);
    expect(rows[0]?.balance).toBe('77');
    expect(rows[0]?.source).toBe('manual');
  });

  test('an account whose wallet row is gone is not a sync destination either', async () => {
    const f = fixture!;
    // `SyncWalletBalancesUseCase` walks the user's ACTIVE wallets and refuses
    // to resurrect an account whose wallet is gone, so `metadata.userWalletId`
    // alone is not evidence anything still syncs this account.
    await db
      .update(schema.userWallets)
      .set({ isActive: false })
      .where(eq(schema.userWallets.userId, f.userId));

    const outId = await insertOutflow(f, { at: anchor(), quantity: '-12', externalId: 's356-4' });
    expect(
      await service().resolve(f.userId, outId, 'internal', {
        destination: { accountId: f.walletSyncedAccountId, holdingId: null },
      })
    ).toEqual({ ok: true });

    const rows = await createdHolding(f, f.walletSyncedAccountId);
    expect(rows[0]?.balance).toBe('12');
    expect(rows[0]?.source).toBe('manual');
  });

  test('a split’s internal portion opens the same way — the portion, not the row', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-4000', externalId: 's356-5' });

    expect(
      await service().resolveSplit(f.userId, outId, [
        {
          decision: 'internal',
          quantity: '3500',
          destination: { accountId: f.walletSyncedAccountId, holdingId: null },
        },
        { decision: 'left_control', quantity: '500' },
      ])
    ).toEqual({ ok: true });

    const rows = await createdHolding(f, f.walletSyncedAccountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.balance).toBe('0');
    expect(rows[0]?.source).toBe('blockchain');
    const [inflow] = await createdInflows(f, outId);
    expect(inflow?.quantity).toBe('3500');
  });
});

/**
 * SC-631. Reopening an `internal` answer deletes the arrival it wrote and used
 * to leave the HOLDING that answer created standing — at the amount that
 * moved, with nothing in the ledger explaining it and no sync allowed to
 * correct it (`HoldingsSyncHelper` skips `manual` rows).
 *
 * Every test here asserts the state of the HOLDING after a reopen, because
 * that is the number a person sees. "The arrival row is gone" was already
 * asserted and is true of the bug.
 */
describe('TransferReviewService — reopening an answer that had to create its destination', () => {
  async function holdingsIn(f: Fixture, accountId: string) {
    return db
      .select()
      .from(schema.holdings)
      .where(
        and(
          eq(schema.holdings.userId, f.userId),
          eq(schema.holdings.accountId, accountId),
          eq(schema.holdings.tokenId, f.tokenId)
        )
      );
  }

  /** Answer `internal` into the empty, non-sync-owned account — the shape
   *  SC-187 was built for and the one that opens at the moved amount. */
  async function answerIntoEmptyAccount(
    f: Fixture,
    opts: { quantity: string; externalId: string }
  ): Promise<{ outId: string; holdingId: string }> {
    const outId = await insertOutflow(f, {
      at: anchor(),
      quantity: `-${opts.quantity}`,
      externalId: opts.externalId,
    });
    expect(
      await service().resolve(f.userId, outId, 'internal', {
        destination: { accountId: f.emptyAccountId, holdingId: null },
      })
    ).toEqual({ ok: true });
    const created = await holdingsIn(f, f.emptyAccountId);
    expect(created).toHaveLength(1);
    expect(created[0]?.balance).toBe(opts.quantity);
    expect(created[0]?.source).toBe('manual');
    return { outId, holdingId: created[0]?.id ?? '' };
  }

  test('the created holding goes with the answer', async () => {
    const f = fixture!;
    const { outId } = await answerIntoEmptyAccount(f, { quantity: '250', externalId: 's631-1' });

    // IF YOU ARE READING THIS BECAUSE THIS TEST WENT RED, IT IS PROBABLY NOT
    // STALE. `writeInflow` creates its destination with a direct
    // `tx.insert(schema.holdings)` and records NO balance observation, unlike
    // `HoldingService.createHoldingWithEvent`, which records one — a live
    // SC-245 residual. Repairing that by having `writeInflow` record a
    // creation observation gives every holding it opens one immediately, so
    // `holdingIsUntouched` answers "touched" for all of them and SC-631 stops
    // deleting anything. Measured: that change fails exactly here and nowhere
    // else, which is why this test is the whole warning.
    //
    // The repair is still right; it just needs the creation observation to be
    // distinguishable from one a person caused, the way `holding_coverage` is
    // excluded for being derived. Deleting this assertion buys a green suite
    // and puts the money bug back.
    expect(await service().reopen(f.userId, outId)).toBe(true);

    // THE NUMBER A PERSON SEES. Before this fix the account went on showing
    // 250 of a token it held none of before the answer, with zero ledger rows
    // to explain it and the answer that put it there withdrawn.
    expect(await holdingsIn(f, f.emptyAccountId)).toEqual([]);
  });

  test('a destination that already existed is left alone', async () => {
    const f = fixture!;
    // MUST-BE-ABSENT. `writeInflow` never moved this row's balance, so it is
    // not this reopen's to remove. A fix that deleted on "the arrival was
    // here" rather than on "this answer created it" fails exactly here.
    const [before] = await db
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.id, f.inHoldingId));
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-40', externalId: 's631-2' });
    expect(
      await service().resolve(f.userId, outId, 'internal', {
        destination: { accountId: f.inAccountId, holdingId: f.inHoldingId },
      })
    ).toEqual({ ok: true });

    expect(await service().reopen(f.userId, outId)).toBe(true);

    const after = await db
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.id, f.inHoldingId));
    expect(after).toHaveLength(1);
    expect(after[0]?.balance).toBe(before?.balance ?? '');
  });

  test('a created holding the owner has since edited is left alone', async () => {
    const f = fixture!;
    const { outId, holdingId } = await answerIntoEmptyAccount(f, {
      quantity: '250',
      externalId: 's631-3',
    });
    // A `growth` edit writes an OBSERVATION and no ledger row at all
    // (`ManualBalanceEditService` returns before the transaction insert), so
    // "nothing in the ledger" is not enough to call the row untouched.
    // Deleting here would discard a figure the owner typed.
    await db.insert(schema.holdingBalanceObservations).values({
      userId: f.userId,
      holdingId,
      balance: '312',
      observedAt: new Date(),
      source: 'user-balance-edit',
    });

    expect(await service().reopen(f.userId, outId)).toBe(true);

    const after = await holdingsIn(f, f.emptyAccountId);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(holdingId);
  });

  test('a created holding that has acquired other ledger rows is left alone', async () => {
    const f = fixture!;
    const { outId, holdingId } = await answerIntoEmptyAccount(f, {
      quantity: '250',
      externalId: 's631-4',
    });
    await db.insert(schema.holdingTransactions).values({
      userId: f.userId,
      holdingId,
      tokenId: f.tokenId,
      kind: 'deposit',
      quantity: '10',
      occurredAt: new Date(),
      source: 'kraken-api',
      externalId: 's631-4-later',
    });

    expect(await service().reopen(f.userId, outId)).toBe(true);

    const after = await holdingsIn(f, f.emptyAccountId);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(holdingId);
  });

  test('an arrival carrying no marker at all is left alone', async () => {
    const f = fixture!;
    const { outId, holdingId } = await answerIntoEmptyAccount(f, {
      quantity: '250',
      externalId: 's631-5',
    });
    // The row a PRE-SC-631 writer left behind: an arrival whose metadata says
    // nothing either way. Absence is not `false` — it means nobody recorded
    // whether this answer created the destination, and deleting a holding on
    // that is a guess about somebody's money. This is the test that separates
    // the fix from a fix-shaped thing: strip the marker's writer and the four
    // tests above go red, but THIS one stays green either way, which is what
    // makes "the marker was never wired up" a state the reader can be in
    // rather than a silent no-op.
    await db
      .update(schema.holdingTransactions)
      .set({ sourceMetadata: { outflowTransactionId: outId } })
      .where(
        and(
          eq(schema.holdingTransactions.source, 'transfer-review'),
          eq(schema.holdingTransactions.externalId, outId)
        )
      );

    expect(await service().reopen(f.userId, outId)).toBe(true);

    const after = await holdingsIn(f, f.emptyAccountId);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(holdingId);
  });
});

/**
 * SC-856. `writeInflow` never moved an existing destination's balance, on the
 * premise that the destination's own sync had already observed the arrival.
 * That premise is a claim about the DESTINATION, and it is false wherever
 * nothing syncs it: the answer recorded the arrival, moved no money, the owner
 * raised the balance by hand, and THAT edit wrote a second arrival. Measured on
 * production 2026-08-28/29 — one movement out of an imported account left THREE
 * arrival rows on a hand-maintained savings holding at `source = 'manual'`.
 *
 * The fix is not "move every anchor", which is the double-count SC-614 split
 * the callers to avoid. It is the discriminator `openingOf` already uses, plus
 * the half `openingOf` never needed: a holding at `source = 'manual'` is one
 * `HoldingsSyncHelper` refuses to touch whatever its account looks like.
 */
describe('TransferReviewService — an arrival nobody else will observe (SC-856)', () => {
  async function balanceOf(holdingId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ balance: schema.holdings.balance })
      .from(schema.holdings)
      .where(eq(schema.holdings.id, holdingId));
    return row?.balance;
  }

  async function setBalance(holdingId: string, balance: string): Promise<void> {
    await db.update(schema.holdings).set({ balance }).where(eq(schema.holdings.id, holdingId));
  }

  async function arrivals(f: Fixture, outflowId: string) {
    return db
      .select()
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, f.userId),
          eq(schema.holdingTransactions.source, 'transfer-review'),
          eq(schema.holdingTransactions.externalId, outflowId)
        )
      );
  }

  async function observationCount(holdingId: string): Promise<number> {
    const rows = await db
      .select({ id: schema.holdingBalanceObservations.id })
      .from(schema.holdingBalanceObservations)
      .where(eq(schema.holdingBalanceObservations.holdingId, holdingId));
    return rows.length;
  }

  /** A holding in the given account, at the given `holdings.source`. */
  async function holdingIn(f: Fixture, accountId: string, source: string, balance: string) {
    const [row] = await db
      .insert(schema.holdings)
      .values({ userId: f.userId, accountId, tokenId: f.tokenId, balance, source })
      .returning();
    if (!row) throw new Error('holding insert failed');
    return row.id;
  }

  test('the reported shape: one movement, one arrival, and the money is there', async () => {
    const f = fixture!;
    // Synthetic, and to eight decimal places on purpose: the reported holding's
    // balance carried that much precision, so a fixture that rounded would not
    // exercise the `Decimal` addition the anchor move performs. The digits are
    // sequential so nobody mistakes them for a figure off a real account.
    await setBalance(f.inHoldingId, '1000.12345678');
    const outId = await insertOutflow(f, {
      at: anchor(),
      quantity: '-2000',
      externalId: 'sc856-reported',
    });

    expect(
      await service().resolve(f.userId, outId, 'internal', {
        destination: { accountId: f.inAccountId, holdingId: f.inHoldingId },
      })
    ).toEqual({ ok: true });

    // The number a person would notice being wrong, carried to the last place.
    // Leaving the anchor where it was is what left the owner to raise it by
    // hand, and their edit is what wrote the second arrival.
    expect(await balanceOf(f.inHoldingId)).toBe('3000.12345678');
    // ONE arrival, not the three the reported holding carries. There is nothing
    // left for the owner to do, so no `user-balance-edit` deposit follows.
    expect(await arrivals(f, outId)).toHaveLength(1);
  });

  test('a destination an EXCHANGE sync owns is left alone — the double-count', async () => {
    const f = fixture!;
    const syncedHoldingId = await holdingIn(
      f,
      f.exchangeSyncedAccountId,
      'sync_exchange_balances',
      '500'
    );
    const outId = await insertOutflow(f, {
      at: anchor(),
      quantity: '-2000',
      externalId: 'sc856-cex',
    });

    expect(
      await service().resolve(f.userId, outId, 'internal', {
        destination: { accountId: f.exchangeSyncedAccountId, holdingId: syncedHoldingId },
      })
    ).toEqual({ ok: true });

    // The hourly exchange sync fetched this balance and the 2,000 is already
    // in it. Moving the anchor here is exactly what the SC-187 behaviour
    // existed to prevent, and what SC-614 declined to do by adding a flag.
    expect(await balanceOf(syncedHoldingId)).toBe('500');
    expect(await arrivals(f, outId)).toHaveLength(1);
  });

  test('a WALLET-synced destination is left alone too', async () => {
    const f = fixture!;
    const syncedHoldingId = await holdingIn(f, f.walletSyncedAccountId, 'blockchain', '500');
    const outId = await insertOutflow(f, {
      at: anchor(),
      quantity: '-2000',
      externalId: 'sc856-wallet',
    });

    await service().resolve(f.userId, outId, 'internal', {
      destination: { accountId: f.walletSyncedAccountId, holdingId: syncedHoldingId },
    });

    expect(await balanceOf(syncedHoldingId)).toBe('500');
  });

  test('a MANUAL holding on a sync-owned account still moves — the half an account check misses', async () => {
    const f = fixture!;
    // The reported shape. `resolveSyncSource` says this account is owned by
    // the exchange sync, and `HoldingsSyncHelper` skips the row anyway because
    // it is `manual` — so nobody corrects it and the account-level answer is
    // the wrong one. A discriminator reading only the account leaves the very
    // row SC-856 was filed about unfixed.
    const manualOnSynced = await holdingIn(f, f.exchangeSyncedAccountId, 'manual', '500');
    const outId = await insertOutflow(f, {
      at: anchor(),
      quantity: '-2000',
      externalId: 'sc856-manual-on-synced',
    });

    await service().resolve(f.userId, outId, 'internal', {
      destination: { accountId: f.exchangeSyncedAccountId, holdingId: manualOnSynced },
    });

    expect(await balanceOf(manualOnSynced)).toBe('2500');
  });

  test('the moved anchor is observed, so history is not reconstructed from a gap', async () => {
    const f = fixture!;
    await setBalance(f.inHoldingId, '500');
    const before = await observationCount(f.inHoldingId);
    const outId = await insertOutflow(f, {
      at: anchor(),
      quantity: '-2000',
      externalId: 'sc856-obs',
    });

    await service().resolve(f.userId, outId, 'internal', {
      destination: { accountId: f.inAccountId, holdingId: f.inHoldingId },
    });

    // SC-245: a balance mutation with no observation does not degrade
    // `BalanceAtTimeService`, it makes it confidently wrong on every date
    // after the gap. This is why the move goes through `UpdateHoldingUseCase`
    // rather than an `UPDATE holdings SET balance` of its own.
    expect(await observationCount(f.inHoldingId)).toBe(before + 1);
  });

  test('the move writes no ledger row of its own — the arrival IS the entry', async () => {
    const f = fixture!;
    await setBalance(f.inHoldingId, '500');
    const outId = await insertOutflow(f, {
      at: anchor(),
      quantity: '-2000',
      externalId: 'sc856-no-synth',
    });

    await service().resolve(f.userId, outId, 'internal', {
      destination: { accountId: f.inAccountId, holdingId: f.inHoldingId },
    });

    // A synthesized `deposit` beside the `transfer_in` would be the same
    // double-count arriving by the other door — and ungrouped, so
    // `walkComponent` would open a fresh lot at market for it.
    const rows = await db
      .select()
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, f.userId),
          eq(schema.holdingTransactions.holdingId, f.inHoldingId)
        )
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('transfer_in');
    expect(rows[0]?.source).toBe('transfer-review');
  });

  test('reopening a SYNC-OWNED destination takes nothing off its balance', async () => {
    const f = fixture!;
    const syncedHoldingId = await holdingIn(
      f,
      f.exchangeSyncedAccountId,
      'sync_exchange_balances',
      '500'
    );
    const outId = await insertOutflow(f, {
      at: anchor(),
      quantity: '-2000',
      externalId: 'sc856-reopen-synced',
    });
    await service().resolve(f.userId, outId, 'internal', {
      destination: { accountId: f.exchangeSyncedAccountId, holdingId: syncedHoldingId },
    });

    expect(await service().reopen(f.userId, outId)).toBe(true);

    // The answer moved nothing, so the undo must move nothing. Reversing on
    // the shape of the answer rather than on what it did would take 2,000 off
    // a balance its sync stated.
    expect(await balanceOf(syncedHoldingId)).toBe('500');
  });

  test('reopening an arrival written BEFORE this fix takes nothing off either', async () => {
    const f = fixture!;
    await setBalance(f.inHoldingId, '500');
    const outId = await insertOutflow(f, {
      at: anchor(),
      quantity: '-2000',
      externalId: 'sc856-legacy',
    });
    await service().resolve(f.userId, outId, 'internal', {
      destination: { accountId: f.inAccountId, holdingId: f.inHoldingId },
    });
    // Every arrival row in production today looks like this: no marker at all.
    // Those answers moved no anchor, so there is nothing to put back — and
    // `unrecorded` is refused rather than read as `not_moved`, so a writer
    // that stopped setting the key cannot quietly start reversing money.
    await db
      .update(schema.holdingTransactions)
      .set({ sourceMetadata: { outflowTransactionId: outId } })
      .where(
        and(
          eq(schema.holdingTransactions.source, 'transfer-review'),
          eq(schema.holdingTransactions.externalId, outId)
        )
      );
    await setBalance(f.inHoldingId, '500');

    expect(await service().reopen(f.userId, outId)).toBe(true);

    expect(await balanceOf(f.inHoldingId)).toBe('500');
  });

  test('a split’s internal portion is restored by its PORTION, not the row', async () => {
    const f = fixture!;
    await setBalance(f.inHoldingId, '500');
    const outId = await insertOutflow(f, {
      at: anchor(),
      quantity: '-4000',
      externalId: 'sc856-split',
    });

    expect(
      await service().resolveSplit(f.userId, outId, [
        {
          decision: 'internal',
          quantity: '3500',
          destination: { accountId: f.inAccountId, holdingId: f.inHoldingId },
        },
        { decision: 'left_control', quantity: '500' },
      ])
    ).toEqual({ ok: true });
    expect(await balanceOf(f.inHoldingId)).toBe('4000');

    expect(await service().reopen(f.userId, outId)).toBe(true);

    // 500, not 0: the arrival's own quantity is what comes off, and the 500
    // that genuinely left never arrived here.
    expect(await balanceOf(f.inHoldingId)).toBe('500');
  });

  test('the picker says which destinations move, with the write path’s own rule', async () => {
    const f = fixture!;
    const syncedHoldingId = await holdingIn(
      f,
      f.exchangeSyncedAccountId,
      'sync_exchange_balances',
      '500'
    );
    const outId = await insertOutflow(f, {
      at: anchor(),
      quantity: '-2000',
      externalId: 'sc856-picker',
    });

    const offered = await service().listDestinations(f.userId, outId);
    const by = (holdingId: string | null, accountId: string) =>
      offered.find((d) => d.holdingId === holdingId && d.accountId === accountId);

    // The sentence over the button has to agree with the write, and this is
    // the only reason the flag is computed on the server: `source` alone
    // cannot say whether a sync owns the ACCOUNT.
    expect(by(f.inHoldingId, f.inAccountId)?.movesBalance).toBe(true);
    expect(by(syncedHoldingId, f.exchangeSyncedAccountId)?.movesBalance).toBe(false);
    // No holding yet: `openingOf` opens at the moved amount where nobody
    // syncs, and at zero where somebody does.
    expect(by(null, f.emptyAccountId)?.movesBalance).toBe(true);
    expect(by(null, f.walletSyncedAccountId)?.movesBalance).toBe(false);
  });

  test('a destination the answer CREATED is still opened, not moved twice', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, {
      at: anchor(),
      quantity: '-250',
      externalId: 'sc856-created',
    });

    await service().resolve(f.userId, outId, 'internal', {
      destination: { accountId: f.emptyAccountId, holdingId: null },
    });

    const [created] = await db
      .select()
      .from(schema.holdings)
      .where(
        and(
          eq(schema.holdings.userId, f.userId),
          eq(schema.holdings.accountId, f.emptyAccountId),
          eq(schema.holdings.tokenId, f.tokenId)
        )
      );
    // `openingOf` already put the money in when it opened the row. Adding the
    // 250 again here would be 500 in an account that received 250 — the same
    // arithmetic error this ticket is about, in the other direction.
    expect(created?.balance).toBe('250');
  });
});

describe('TransferReviewService — where a transfer can go', () => {
  test('lists every holding of the token except the one it left', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 'd-1' });

    const destinations = await service().listDestinations(f.userId, outId);
    const holdingIds = destinations.map((d) => d.holdingId);
    expect(holdingIds).toContain(f.inHoldingId);
    expect(holdingIds).toContain(f.sameAccountHoldingId);
    expect(holdingIds).not.toContain(f.outHoldingId);
  });

  test('carries the balance and the source, which is how two look-alikes are told apart', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 'd-2' });

    const destinations = await service().listDestinations(f.userId, outId);
    const sibling = destinations.find((d) => d.holdingId === f.sameAccountHoldingId);
    // Same account name and same symbol as the holding it left; the balance is
    // the only thing that distinguishes them on screen.
    expect(sibling?.balance).toBe('6500.32');
    expect(sibling?.source).toBe('manual');
  });

  test('offers an account that holds none of this token, marked as such', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 'd-3' });

    const destinations = await service().listDestinations(f.userId, outId);
    const empty = destinations.find((d) => d.accountId === f.emptyAccountId);
    expect(empty?.holdingId).toBeNull();
    expect(empty?.balance).toBeNull();
  });

  test('is empty for a transfer that is not the caller’s', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 'd-4' });
    expect(await service().listDestinations(randomUUID(), outId)).toEqual([]);
  });

  /**
   * The ordering is the half of SC-850 that changes the ANSWER (mgrin,
   * 2026-08-29). Production offered a SOL transfer an Airwallex fiat account
   * and a Bitcoin wallet above every Solana wallet, every row reading "No SOL
   * tracked here yet", because the list was sorted by account name.
   *
   * Alphabetical was never neutral — it was a ranking too, by a fact about the
   * name. Ranking by what the app already knows about each destination is not
   * a guess and does not pre-select: every account is still offered, nothing
   * is checked, and the reader can scroll past the whole first band.
   */
  test('ranks accounts that already hold the token above the rest', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 'd-5' });

    const destinations = await service().listDestinations(f.userId, outId);
    const bands = destinations.map((d) => d.relevance);
    // Sorted, therefore already grouped: no band reappears after another.
    expect(bands).toEqual([...bands].sort((a, b) => bands.indexOf(a) - bands.indexOf(b)));
    expect(bands[0]).toBe('holds_token');
    expect(
      destinations.filter((d) => d.relevance === 'holds_token').map((d) => d.holdingId)
    ).toEqual(expect.arrayContaining([f.inHoldingId, f.sameAccountHoldingId]));
  });

  test('an account on the chain the money is leaving outranks one that is not', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 'd-6' });

    const destinations = await service().listDestinations(f.userId, outId);
    const synced = destinations.find((d) => d.accountId === f.walletSyncedAccountId);
    const empty = destinations.find((d) => d.accountId === f.emptyAccountId);
    // Both track no position in this token, so the old list ordered them by
    // name — and `zz-empty-…` sorts BEFORE `zz-synced-wallet-…`, putting the
    // account that cannot receive this asset above the one that can.
    expect(synced?.relevance).toBe('same_network');
    expect(empty?.relevance).toBe('other');
    expect(destinations.indexOf(synced!)).toBeLessThan(destinations.indexOf(empty!));
  });

  test('an account on a DIFFERENT chain is not same-network', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 'd-7' });

    const destinations = await service().listDestinations(f.userId, outId);
    // The fixture's bridge account is chain 8453 against the outflow's chain
    // 1 — the same wallet, and still not somewhere this token can land. The
    // exchange account carries no chain at all. Only the one account on the
    // source's own chain earns the band.
    expect(
      destinations.filter((d) => d.relevance === 'same_network').map((d) => d.accountId)
    ).toEqual([f.walletSyncedAccountId]);
  });
});

/**
 * The ten answers that booked disposals on mgrin's own wallets (SC-350), as
 * properties rather than as ten rows.
 *
 * Three separate claims, and the middle one is the one the ticket did not know
 * it needed: an inflow the MATCHER has already claimed cannot be paired, and
 * before `unlinkPair` there was no way to free it — `reopen` refuses a row with
 * no `transfer_review`, which is every pairing the matcher has ever made.
 */
describe('TransferReviewService — own-wallet corrections (SC-350)', () => {
  /** Registers `address` as a wallet this user controls. */
  async function addOwnWallet(f: Fixture, address: string): Promise<void> {
    await db
      .insert(schema.userWallets)
      .values({ userId: f.userId, walletAddress: address, institutionIds: [] });
  }

  describe('counterpartyIsOwnWallet', () => {
    test('is true for an address in user_wallets, read from the PAYLOAD', async () => {
      const f = fixture!;
      // All ten production rows have `counterparty` NULL and the address only in
      // `raw_payload.to`. A check against the column would have reported "not
      // yours" about the wallet printed in the very next field.
      await addOwnWallet(f, '0x9d8ae06A94c5592f57812e0F045438602a7E14aB');
      await insertOutflow(f, {
        at: anchor(),
        quantity: '-1000',
        externalId: 'ow-1',
        kind: 'transfer_out',
        rawPayload: { to: '0x9d8ae06a94c5592f57812e0f045438602a7e14ab', hash: '0xabc' },
      });
      const [item] = await service().listPending(f.userId);
      expect(item?.counterpartyIsOwnWallet).toBe(true);
    });

    test('matches regardless of EIP-55 casing', async () => {
      const f = fixture!;
      // The two sides come from different places: `user_wallets` holds what the
      // user pasted, the counterparty comes out of a chain payload. One address.
      await addOwnWallet(f, '0x9D8AE06A94C5592F57812E0F045438602A7E14AB');
      await insertOutflow(f, {
        at: anchor(),
        quantity: '-1000',
        externalId: 'ow-2',
        kind: 'transfer_out',
        rawPayload: { to: '0x9d8ae06a94c5592f57812e0f045438602a7e14ab' },
      });
      const [item] = await service().listPending(f.userId);
      expect(item?.counterpartyIsOwnWallet).toBe(true);
    });

    test('is false for an address the user has not registered', async () => {
      const f = fixture!;
      await addOwnWallet(f, '0x9d8ae06a94c5592f57812e0f045438602a7e14ab');
      await insertOutflow(f, {
        at: anchor(),
        quantity: '-1000',
        externalId: 'ow-3',
        kind: 'transfer_out',
        rawPayload: { to: '0x1bac08001d761c303901d5e32273a24c07d3f3da' },
      });
      const [item] = await service().listPending(f.userId);
      expect(item?.counterpartyIsOwnWallet).toBe(false);
    });

    test('is false when another user owns that wallet', async () => {
      const f = fixture!;
      const [other] = await db
        .insert(schema.users)
        .values({ email: `other-${randomUUID().slice(0, 8)}@scani.local`, name: 'Other' })
        .returning();
      await db.insert(schema.userWallets).values({
        userId: other!.id,
        walletAddress: '0xdeadbeef00000000000000000000000000000001',
        institutionIds: [],
      });
      await insertOutflow(f, {
        at: anchor(),
        quantity: '-1000',
        externalId: 'ow-4',
        kind: 'transfer_out',
        rawPayload: { to: '0xdeadbeef00000000000000000000000000000001' },
      });
      const [item] = await service().listPending(f.userId);
      expect(item?.counterpartyIsOwnWallet).toBe(false);
      await db.delete(schema.users).where(eq(schema.users.id, other!.id));
    });
  });

  describe('unlinkPair', () => {
    test('frees both legs of a matcher pairing so the inflow can be claimed', async () => {
      const f = fixture!;
      // The production shape: the arrival at 0x9d8a is already grouped with an
      // unrelated departure from 0x9d8a, so the genuine partner cannot take it.
      const groupId = randomUUID();
      const arrival = await insertInflow(f, {
        at: anchor(),
        quantity: '1000',
        externalId: 'up-in',
        transferGroupId: groupId,
      });
      const wrongPartner = await insertOutflow(f, {
        at: anchor(),
        quantity: '-1000',
        externalId: 'up-wrong',
        kind: 'transfer_out',
        transferGroupId: groupId,
      });
      const misAnswered = await insertOutflow(f, {
        at: anchor(),
        quantity: '-1000',
        externalId: 'up-mis',
        kind: 'transfer_out',
        transferReview: 'left_control',
        transferReviewedAt: new Date(),
      });

      // Before: the pairing blocks the repair outright.
      expect(await service().reopen(f.userId, misAnswered)).toBe(true);
      expect(
        await service().resolve(f.userId, misAnswered, 'paired', { matchTransactionId: arrival })
      ).toEqual({ ok: false, reason: 'partner_gone' });

      const unlinked = await service().unlinkPair(f.userId, arrival);
      expect(unlinked.ok).toBe(true);
      if (unlinked.ok) expect(unlinked.unlinked.sort()).toEqual([arrival, wrongPartner].sort());

      // After: the same call succeeds, and the wrong partner is back in the
      // queue rather than silently realized — `isConfirmedDisposal` is
      // `left_control` alone, so an unanswered outflow books nothing.
      expect(
        await service().resolve(f.userId, misAnswered, 'paired', { matchTransactionId: arrival })
      ).toEqual({ ok: true });
      const pendingIds = (await service().listPending(f.userId)).map((i) => i.transactionId);
      expect(pendingIds).toContain(wrongPartner);
    });

    test('refuses a group a person answered — that is reopen’s job', async () => {
      const f = fixture!;
      // Unlinking here would strand the deposit an `internal` answer wrote, with
      // no group and nothing to delete it, which is the double-count `reopen`
      // exists to avoid.
      const outId = await insertOutflow(f, {
        at: anchor(),
        quantity: '-100',
        externalId: 'up-ans',
        kind: 'transfer_out',
      });
      const inId = await insertInflow(f, {
        at: anchor(),
        quantity: '100',
        externalId: 'up-ans-in',
      });
      expect(
        await service().resolve(f.userId, outId, 'paired', { matchTransactionId: inId })
      ).toEqual({ ok: true });

      expect(await service().unlinkPair(f.userId, outId)).toEqual({
        ok: false,
        reason: 'reviewed',
      });
      expect(await service().unlinkPair(f.userId, inId)).toEqual({ ok: false, reason: 'reviewed' });
    });

    /**
     * SC-376. The dry run of `unpick-same-holding-transfer-groups.ts` promised
     * 7 unlinks against production and `--apply` refused all 7, because the
     * projection modelled the verdict gate and not this one. The repair is that
     * both read `unlinkPairRefusal`, so this asserts the two agree on the rows
     * the write actually refuses — not on a fixture built to match.
     */
    test('the projection refuses exactly the group unlinkPair refuses', async () => {
      const f = fixture!;
      const outId = await insertOutflow(f, {
        at: anchor(),
        quantity: '-100',
        externalId: 'up-agree',
        kind: 'transfer_out',
      });
      const inId = await insertInflow(f, {
        at: anchor(),
        quantity: '100',
        externalId: 'up-agree-in',
      });
      expect(
        await service().resolve(f.userId, outId, 'paired', { matchTransactionId: inId })
      ).toEqual({ ok: true });

      const legsOf = async (id: string) => {
        const [row] = await db
          .select({ groupId: schema.holdingTransactions.transferGroupId })
          .from(schema.holdingTransactions)
          .where(eq(schema.holdingTransactions.id, id))
          .limit(1);
        return db
          .select({ transferReview: schema.holdingTransactions.transferReview })
          .from(schema.holdingTransactions)
          .where(
            and(
              eq(schema.holdingTransactions.userId, f.userId),
              eq(schema.holdingTransactions.transferGroupId, row!.groupId!)
            )
          );
      };

      const answered = await legsOf(outId);
      expect(unlinkPairRefusal(answered)?.reason).toBe('reviewed');
      expect(await service().unlinkPair(f.userId, outId)).toEqual({
        ok: false,
        reason: 'reviewed',
      });

      // `reopen` is the only way out, and it clears the group from both legs —
      // so the refused state is not a dead end the preview leaves the reader in.
      expect(await service().reopen(f.userId, outId)).toBe(true);
      const cleared = await db
        .select({ groupId: schema.holdingTransactions.transferGroupId })
        .from(schema.holdingTransactions)
        .where(inArray(schema.holdingTransactions.id, [outId, inId]));
      expect(cleared.map((r) => r.groupId)).toEqual([null, null]);
    });

    test('is `gone` for an unpaired row, a missing one, and another user’s', async () => {
      const f = fixture!;
      const unpaired = await insertOutflow(f, {
        at: anchor(),
        quantity: '-5',
        externalId: 'up-none',
      });
      expect(await service().unlinkPair(f.userId, unpaired)).toEqual({ ok: false, reason: 'gone' });
      expect(await service().unlinkPair(f.userId, randomUUID())).toEqual({
        ok: false,
        reason: 'gone',
      });
      const groupId = randomUUID();
      const mine = await insertInflow(f, {
        at: anchor(),
        quantity: '5',
        externalId: 'up-mine',
        transferGroupId: groupId,
      });
      expect(await service().unlinkPair(randomUUID(), mine)).toEqual({ ok: false, reason: 'gone' });
    });
  });

  describe('answerSource', () => {
    test('a repair is `repair`, not `user` and not `unattributed`', async () => {
      const f = fixture!;
      const outId = await insertOutflow(f, {
        at: anchor(),
        quantity: '-100',
        externalId: 'as-1',
        kind: 'transfer_out',
      });
      const inId = await insertInflow(f, { at: anchor(), quantity: '100', externalId: 'as-1-in' });
      expect(
        await service().resolve(f.userId, outId, 'paired', {
          matchTransactionId: inId,
          answerSource: 'repair',
        })
      ).toEqual({ ok: true });

      const answered = await service().listAnswered(f.userId);
      const row = answered.items.find((i) => i.transactionId === outId);
      expect(row?.answerSource).toBe('repair');
      // The timestamp is still written: WHEN the correction happened is not in
      // dispute, only who made it. The DTO's invariant — `reviewedAt` is null
      // exactly when the source is `unattributed` — has to keep holding.
      expect(row?.reviewedAt).not.toBeNull();
    });

    test('an ordinary answer is still `user`', async () => {
      const f = fixture!;
      const outId = await insertOutflow(f, {
        at: anchor(),
        quantity: '-100',
        externalId: 'as-2',
        kind: 'transfer_out',
      });
      expect(await service().resolve(f.userId, outId, 'untracked')).toEqual({ ok: true });
      const answered = await service().listAnswered(f.userId);
      expect(answered.items.find((i) => i.transactionId === outId)?.answerSource).toBe('user');
    });

    test('an unstamped row is still `unattributed` — no backfill changed it', async () => {
      const f = fixture!;
      // The 560-row raw UPDATE's shape. Adding the column must not turn it into
      // an attributed answer, which is the forgery the column exists to refuse.
      const outId = await insertOutflow(f, {
        at: anchor(),
        quantity: '-100',
        externalId: 'as-3',
        kind: 'transfer_out',
        transferReview: 'left_control',
      });
      const answered = await service().listAnswered(f.userId);
      const row = answered.items.find((i) => i.transactionId === outId);
      expect(row?.answerSource).toBe('unattributed');
      expect(row?.reviewedAt).toBeNull();
    });

    test('reopening clears the source, so a re-answer is not still a repair', async () => {
      const f = fixture!;
      const outId = await insertOutflow(f, {
        at: anchor(),
        quantity: '-100',
        externalId: 'as-4',
        kind: 'transfer_out',
        transferReview: 'left_control',
        transferReviewedAt: new Date(),
        transferReviewSource: 'repair',
      });
      expect(await service().reopen(f.userId, outId)).toBe(true);
      const [row] = await db
        .select()
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.id, outId));
      expect(row?.transferReviewSource).toBeNull();

      expect(await service().resolve(f.userId, outId, 'untracked')).toEqual({ ok: true });
      const answered = await service().listAnswered(f.userId);
      expect(answered.items.find((i) => i.transactionId === outId)?.answerSource).toBe('user');
    });
  });

  describe('the repair, end to end', () => {
    test('`internal` writes exactly one arrival and `paired` writes none', async () => {
      const f = fixture!;
      // The invariant the whole paired/internal split exists for: answering the
      // four USDC rows `internal` would have created a second arrival each and
      // double-counted 4,000.
      const arrival = await insertInflow(f, {
        at: anchor(),
        quantity: '1000',
        externalId: 'e2e-in',
      });
      const pairedOut = await insertOutflow(f, {
        at: anchor(),
        quantity: '-1000',
        externalId: 'e2e-paired',
        kind: 'transfer_out',
        transferReview: 'left_control',
      });
      const internalOut = await insertOutflow(f, {
        at: anchor(),
        quantity: '-1000',
        externalId: 'e2e-internal',
        kind: 'transfer_out',
        transferReview: 'left_control',
      });

      for (const [id, decision] of [
        [pairedOut, 'paired'],
        [internalOut, 'internal'],
      ] as const) {
        expect(await service().reopen(f.userId, id)).toBe(true);
        const result = await service().resolve(f.userId, id, decision, {
          answerSource: 'repair',
          ...(decision === 'paired'
            ? { matchTransactionId: arrival }
            : { destination: { accountId: f.emptyAccountId, holdingId: null } }),
        });
        expect(result).toEqual({ ok: true });
      }

      const created = await db
        .select({ externalId: schema.holdingTransactions.externalId })
        .from(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.userId, f.userId),
            eq(schema.holdingTransactions.source, 'transfer-review')
          )
        );
      expect(created.map((c) => c.externalId).sort()).toEqual([internalOut]);

      // Neither row is a disposal any more: both carry a group id, and
      // `isConfirmedDisposal` reads `left_control` alone.
      const rows = await db
        .select()
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.userId, f.userId));
      for (const id of [pairedOut, internalOut]) {
        const row = rows.find((r) => r.id === id);
        expect(row?.transferReview).not.toBe('left_control');
        expect(row?.transferGroupId).not.toBeNull();
        expect(row?.transferReviewSource).toBe('repair');
      }
    });
  });
});

/**
 * The review surface must not offer an arrival on the outflow's OWN holding
 * (SC-347).
 *
 * The matcher has refused this shape since SC-350, with its own copy of the
 * guard at the call site. These two tests are the ones that were missing: the
 * QUEUE kept offering it and the manual `paired` path kept accepting it, so the
 * defect survived the fix that was supposed to close it. Production shows what
 * that costs — a reader answered `paired` on a 617.5 USDT arrival three days
 * OLDER than the 567.501 departure it was offered against, both on one holding.
 */
describe('TransferReviewService — same-holding candidates (SC-347)', () => {
  /** An arrival on the very holding the outflow left, which is what the 43
   *  production groups are made of. */
  async function insertSameHoldingArrival(
    f: Fixture,
    opts: { at: Date; quantity: string; externalId: string }
  ): Promise<string> {
    const [row] = await db
      .insert(schema.holdingTransactions)
      .values({
        userId: f.userId,
        holdingId: f.outHoldingId,
        tokenId: f.tokenId,
        kind: 'deposit',
        quantity: opts.quantity,
        occurredAt: opts.at,
        source: 'etherscan',
        externalId: opts.externalId,
      })
      .returning();
    if (!row) throw new Error('same-holding arrival insert failed');
    return row.id;
  }

  test('the queue does not offer it, while still offering the real one', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, quantity: '-100', externalId: 'sh-out' });
    // Identical quantity and one minute later, so it beats the genuine arrival
    // on every score the list sorts by. That is why it was shown FIRST.
    const decoy = await insertSameHoldingArrival(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '100',
      externalId: 'sh-decoy',
    });
    const real = await insertInflow(f, {
      at: new Date(at.getTime() + 120_000),
      quantity: '99.98',
      externalId: 'sh-real',
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.transactionId).toBe(outId);
    const offered = item?.candidates.map((c) => c.transactionId) ?? [];
    // Exactly the real one: the decoy is not merely demoted below it, which is
    // what a sort change would have achieved and would still have let a reader
    // pick it.
    expect(offered).toEqual([real]);
    expect(offered).not.toContain(decoy);
  });

  test('reopenPreview does not count it, which is the gate SC-354 reopens on', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, {
      at,
      quantity: '-100',
      externalId: 'sh-out-3',
      transferReview: 'left_control',
    });
    const decoy = await insertSameHoldingArrival(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '100',
      externalId: 'sh-decoy-3',
    });

    // The whole point of the gate is that "would reopening help?" must be
    // answered by the surface the reader will see. A decoy counted here reads
    // as help and delivers the wrong answer a second time.
    const preview = await service().reopenPreview(f.userId, outId);
    expect(preview.map((c) => c.transactionId)).not.toContain(decoy);
    expect(preview).toEqual([]);
  });

  test('resolve("paired") refuses it, so no new same-holding group can be written', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, quantity: '-100', externalId: 'sh-out-2' });
    const decoy = await insertSameHoldingArrival(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '100',
      externalId: 'sh-decoy-2',
    });

    // `partner_gone` rather than a throw: the answer arrives over HTTP with an
    // id the caller chose, and refusing it is the same outcome as an arrival
    // some other run claimed first.
    expect(
      await service().resolve(f.userId, outId, 'paired', { matchTransactionId: decoy })
    ).toEqual({ ok: false, reason: 'partner_gone' });
    const [row] = await db
      .select({ transferGroupId: schema.holdingTransactions.transferGroupId })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, decoy));
    expect(row?.transferGroupId).toBeNull();
  });
});

/**
 * The invariant SC-350 established, held over the WHOLE table (SC-365).
 *
 * SC-350 corrected ten rows and enforced nothing. It joined `user_wallets`
 * against mgrin's 88 *stamped* answers, so the one violating row that carried
 * no `transfer_review_source` was never in the population — and 56.4% of
 * production's answers carry none. These tests are the assertion that the
 * predicate never reads that column: every source value below is a separate
 * case, and they must all come back.
 */
describe('TransferReviewService — the own-wallet invariant (SC-365)', () => {
  const OWN = '0x141451c9405875cf0cdc23c0ee5be72069231e49';
  const STRANGER = '0x1bac08001d761c303901d5e32273a24c07d3f3da';

  async function addOwnWallet(f: Fixture, address: string): Promise<void> {
    await db
      .insert(schema.userWallets)
      .values({ userId: f.userId, walletAddress: address, institutionIds: [] });
  }

  describe('ownWalletDisposals', () => {
    test('finds an UNATTRIBUTED left_control row — the one SC-350 could not see', async () => {
      const f = fixture!;
      // The production row: 83.985269 USDC that left 0x0158…9630 for
      // 0x1414…1E49 on 2022-08-25, answered by the raw UPDATE of 2026-08-14
      // with neither a source nor a timestamp.
      await addOwnWallet(f, OWN);
      const id = await insertOutflow(f, {
        at: anchor(),
        quantity: '-83.985269',
        externalId: 'sc365-1',
        kind: 'transfer_out',
        transferReview: 'left_control',
        rawPayload: { to: OWN, from: '0x01583d152e3225519d211b1f576d959f70ef9630', hash: '0xbd05' },
      });

      const found = await service().ownWalletDisposals(f.userId);
      expect(found.map((d) => d.transactionId)).toEqual([id]);
      expect(found[0]?.answerSource).toBe('unattributed');
      expect(found[0]?.counterparty).toBe(OWN);
    });

    test.each([
      'user',
      'repair',
    ] as const)('finds a %s-stamped left_control row too — the source is reported, never filtered on', async (source) => {
      const f = fixture!;
      await addOwnWallet(f, OWN);
      const id = await insertOutflow(f, {
        at: anchor(),
        quantity: '-100',
        externalId: `sc365-src-${source}`,
        kind: 'transfer_out',
        transferReview: 'left_control',
        transferReviewedAt: anchor(),
        transferReviewSource: source,
        rawPayload: { to: OWN },
      });

      const found = await service().ownWalletDisposals(f.userId);
      expect(found.map((d) => d.transactionId)).toEqual([id]);
      expect(found[0]?.answerSource).toBe(source);
    });

    test('finds a SPLIT row whose left_control portion realizes onto an own wallet', async () => {
      const f = fixture!;
      // `transfer_review` is 'split' here, not 'left_control'. A predicate
      // reading that column alone calls this clean, and `CostBasisService`
      // realizes the 600 anyway — it walks portions.
      await addOwnWallet(f, OWN);
      const id = await insertOutflow(f, {
        at: anchor(),
        quantity: '-1000',
        externalId: 'sc365-split',
        kind: 'transfer_out',
        rawPayload: { to: OWN },
      });
      await db
        .update(schema.holdingTransactions)
        .set({
          transferReview: 'split',
          transferReviewSplit: [
            { decision: 'left_control', quantity: '600' },
            { decision: 'untracked', quantity: '400' },
          ],
        })
        .where(eq(schema.holdingTransactions.id, id));

      const found = await service().ownWalletDisposals(f.userId);
      expect(found.map((d) => d.transactionId)).toEqual([id]);
      expect(found[0]?.decision).toBe('split');
    });

    test('ignores a split with no left_control portion', async () => {
      const f = fixture!;
      await addOwnWallet(f, OWN);
      const id = await insertOutflow(f, {
        at: anchor(),
        quantity: '-1000',
        externalId: 'sc365-split-clean',
        kind: 'transfer_out',
        rawPayload: { to: OWN },
      });
      await db
        .update(schema.holdingTransactions)
        .set({
          transferReview: 'split',
          transferReviewSplit: [
            { decision: 'untracked', quantity: '600' },
            {
              decision: 'internal',
              quantity: '400',
              destination: { accountId: f.inAccountId, holdingId: f.inHoldingId },
            },
          ],
        })
        .where(eq(schema.holdingTransactions.id, id));

      expect(await service().ownWalletDisposals(f.userId)).toEqual([]);
    });

    test('ignores a left_control row that went to an address the user has not registered', async () => {
      const f = fixture!;
      await addOwnWallet(f, OWN);
      await insertOutflow(f, {
        at: anchor(),
        quantity: '-100',
        externalId: 'sc365-stranger',
        kind: 'transfer_out',
        transferReview: 'left_control',
        rawPayload: { to: STRANGER },
      });
      expect(await service().ownWalletDisposals(f.userId)).toEqual([]);
    });

    test.each([
      'internal',
      'untracked',
    ] as const)('ignores a %s answer to an own wallet — it books nothing', async (decision) => {
      const f = fixture!;
      await addOwnWallet(f, OWN);
      await insertOutflow(f, {
        at: anchor(),
        quantity: '-100',
        externalId: `sc365-ok-${decision}`,
        kind: 'transfer_out',
        transferReview: decision,
        rawPayload: { to: OWN },
      });
      expect(await service().ownWalletDisposals(f.userId)).toEqual([]);
    });

    test('reads the address from the PAYLOAD, and matches across EIP-55 casing', async () => {
      const f = fixture!;
      // Every etherscan row this was built for has `counterparty` NULL and the
      // address only in `raw_payload.to`, in mixed case.
      await addOwnWallet(f, '0x141451C9405875CF0CdC23C0eE5be72069231E49');
      const id = await insertOutflow(f, {
        at: anchor(),
        quantity: '-100',
        externalId: 'sc365-case',
        kind: 'transfer_out',
        transferReview: 'left_control',
        rawPayload: { to: '0x141451c9405875cf0cdc23c0ee5be72069231e49' },
      });
      expect((await service().ownWalletDisposals(f.userId)).map((d) => d.transactionId)).toEqual([
        id,
      ]);
    });

    test('is empty for a user who has registered no wallets', async () => {
      const f = fixture!;
      await insertOutflow(f, {
        at: anchor(),
        quantity: '-100',
        externalId: 'sc365-nowallets',
        kind: 'transfer_out',
        transferReview: 'left_control',
        rawPayload: { to: OWN },
      });
      expect(await service().ownWalletDisposals(f.userId)).toEqual([]);
    });
  });

  describe('resolve refuses a disposal onto an own wallet', () => {
    test('left_control is refused, and the row stays in the queue', async () => {
      const f = fixture!;
      // `counterpartyIsOwnWallet` already told mgrin this, on the row, and he
      // answered left_control ten times anyway. Showing is not preventing.
      await addOwnWallet(f, OWN);
      const id = await insertOutflow(f, {
        at: anchor(),
        quantity: '-100',
        externalId: 'sc365-guard-1',
        kind: 'transfer_out',
        rawPayload: { to: OWN },
      });

      expect(await service().resolve(f.userId, id, 'left_control')).toEqual({
        ok: false,
        reason: 'own_wallet_destination',
        address: OWN,
      });
      const [row] = await db
        .select({ review: schema.holdingTransactions.transferReview })
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.id, id));
      expect(row?.review).toBeNull();
    });

    test('untracked is still allowed on the same row — it realizes nothing', async () => {
      const f = fixture!;
      await addOwnWallet(f, OWN);
      const id = await insertOutflow(f, {
        at: anchor(),
        quantity: '-100',
        externalId: 'sc365-guard-2',
        kind: 'transfer_out',
        rawPayload: { to: OWN },
      });
      expect(await service().resolve(f.userId, id, 'untracked')).toEqual({ ok: true });
    });

    test('left_control to a stranger is untouched', async () => {
      const f = fixture!;
      await addOwnWallet(f, OWN);
      const id = await insertOutflow(f, {
        at: anchor(),
        quantity: '-100',
        externalId: 'sc365-guard-3',
        kind: 'transfer_out',
        rawPayload: { to: STRANGER },
      });
      expect(await service().resolve(f.userId, id, 'left_control')).toEqual({ ok: true });
    });

    test('a SPLIT carrying a left_control portion is refused whole', async () => {
      const f = fixture!;
      await addOwnWallet(f, OWN);
      const id = await insertOutflow(f, {
        at: anchor(),
        quantity: '-1000',
        externalId: 'sc365-guard-4',
        kind: 'transfer_out',
        rawPayload: { to: OWN },
      });

      expect(
        await service().resolveSplit(f.userId, id, [
          { decision: 'left_control', quantity: '600' },
          { decision: 'untracked', quantity: '400' },
        ])
      ).toEqual({ ok: false, reason: 'own_wallet_destination', address: OWN });
      const [row] = await db
        .select({ review: schema.holdingTransactions.transferReview })
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.id, id));
      expect(row?.review).toBeNull();
    });
  });
});

/**
 * Standing address rules, as the queue sees them (SC-375).
 *
 * The rules themselves are written and revoked in
 * `TransferReviewRuleService.test.ts`; these are about the read that applies
 * them, so the rows go in directly. Two properties carry the whole design and
 * each has its own test: a rule changes what the queue SHOWS and never what a
 * row SAYS, and matching is exact equality against the address the queue
 * itself reads — the payload's, not the column's.
 */
describe('TransferReviewService — address rules', () => {
  const RULE_ADDRESS = '0x7A3f91B2c4D5e6F708192a3B4c5D6e7F8091A2b3';
  const RULE_LOOKALIKE = '0x7A3f91B2c4D5e6F708192a3B4c5D6e7F8091A2b4';

  async function addRule(
    f: Fixture,
    opts: {
      address: string;
      verdict: 'not_a_disposal' | 'ask_me';
      note?: string;
      userId?: string;
      revokedAt?: Date;
    }
  ): Promise<string> {
    const [row] = await db
      .insert(schema.transferReviewRules)
      .values({
        userId: opts.userId ?? f.userId,
        matchCounterparty: opts.address.trim().toLowerCase(),
        verdict: opts.verdict,
        note: opts.note ?? 'my Bybit deposit',
        ...(opts.revokedAt ? { revokedAt: opts.revokedAt } : {}),
      })
      .returning();
    if (!row) throw new Error('rule insert failed');
    return row.id;
  }

  test('a not_a_disposal rule takes the row out of the queue and puts it in the hidden list', async () => {
    const f = fixture!;
    const id = await insertOutflow(f, {
      at: anchor(),
      externalId: 'rule-1',
      rawPayload: { to: RULE_ADDRESS },
    });
    const ruleId = await addRule(f, { address: RULE_ADDRESS, verdict: 'not_a_disposal' });

    expect(await service().listPending(f.userId)).toEqual([]);
    // The count and the page are one set. A badge of 1 over an empty page is
    // the disagreement this join exists on both queries to prevent.
    expect((await service().pendingSummary(f.userId)).count).toBe(0);

    const hidden = await service().listHiddenByRule(f.userId);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]?.transactionId).toBe(id);
    expect(hidden[0]?.ruleId).toBe(ruleId);
    expect(hidden[0]?.ruleNote).toBe('my Bybit deposit');
    expect(hidden[0]?.counterparty).toBe(RULE_ADDRESS);
  });

  test('a hidden row is unchanged, still answerable, and comes back when the rule is revoked', async () => {
    const f = fixture!;
    const id = await insertOutflow(f, {
      at: anchor(),
      externalId: 'rule-2',
      rawPayload: { to: RULE_ADDRESS },
    });
    const ruleId = await addRule(f, { address: RULE_ADDRESS, verdict: 'not_a_disposal' });
    expect((await service().pendingSummary(f.userId)).count).toBe(0);

    // Nothing was written to the row — which is the whole reason the undo is
    // free. There is no `transfer_review` to reopen and no repair to run.
    const [before] = await db
      .select({
        review: schema.holdingTransactions.transferReview,
        source: schema.holdingTransactions.transferReviewSource,
        reviewedAt: schema.holdingTransactions.transferReviewedAt,
        groupId: schema.holdingTransactions.transferGroupId,
      })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, id));
    expect(before?.review).toBeNull();
    expect(before?.source).toBeNull();
    expect(before?.reviewedAt).toBeNull();
    expect(before?.groupId).toBeNull();

    // And it is still answerable: the write path's gate knows nothing about
    // rules, so a reader who opens a hidden row can answer it without having
    // to revoke the rule to reach their own transfer.
    expect(await service().resolve(f.userId, id, 'untracked')).toEqual({ ok: true });
    await db
      .update(schema.holdingTransactions)
      .set({ transferReview: null, transferReviewedAt: null, transferReviewSource: null })
      .where(eq(schema.holdingTransactions.id, id));

    await db
      .update(schema.transferReviewRules)
      .set({ revokedAt: new Date() })
      .where(eq(schema.transferReviewRules.id, ruleId));

    expect((await service().pendingSummary(f.userId)).count).toBe(1);
    expect(await service().listHiddenByRule(f.userId)).toEqual([]);
  });

  test('an ask_me rule leaves the row in the queue, wearing the note', async () => {
    const f = fixture!;
    await insertOutflow(f, {
      at: anchor(),
      externalId: 'rule-3',
      rawPayload: { to: RULE_ADDRESS },
    });
    const ruleId = await addRule(f, {
      address: RULE_ADDRESS,
      verdict: 'ask_me',
      note: 'my cold wallet — check the amount',
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.matchedRule?.ruleId).toBe(ruleId);
    expect(item?.matchedRule?.note).toBe('my cold wallet — check the amount');
    expect(await service().listHiddenByRule(f.userId)).toEqual([]);
  });

  test('matching is exact and case-insensitive — a one-character lookalike does not match', async () => {
    const f = fixture!;
    await insertOutflow(f, {
      at: anchor(),
      externalId: 'rule-4a',
      rawPayload: { to: RULE_ADDRESS.toLowerCase() },
    });
    await insertOutflow(f, {
      at: anchor(),
      externalId: 'rule-4b',
      rawPayload: { to: RULE_LOOKALIKE },
    });
    await addRule(f, { address: RULE_ADDRESS, verdict: 'not_a_disposal' });

    // The rule was written in EIP-55 mixed case and the row carries the
    // lowercase form; both sides normalize, so it matches.
    const pending = await service().listPending(f.userId);
    expect(pending).toHaveLength(1);
    // Address poisoning plants exactly this: an address differing in one
    // character, on a real token contract. It is a different address and the
    // rule says nothing about it.
    expect(pending[0]?.counterparty).toBe(RULE_LOOKALIKE);
  });

  test('a revoked rule matches nothing', async () => {
    const f = fixture!;
    await insertOutflow(f, {
      at: anchor(),
      externalId: 'rule-5',
      rawPayload: { to: RULE_ADDRESS },
    });
    await addRule(f, {
      address: RULE_ADDRESS,
      verdict: 'not_a_disposal',
      revokedAt: new Date(),
    });

    expect((await service().pendingSummary(f.userId)).count).toBe(1);
    expect(await service().listHiddenByRule(f.userId)).toEqual([]);
    expect((await service().listPending(f.userId))[0]?.matchedRule).toBeNull();
  });

  test("another user's rule does not touch this queue", async () => {
    const f = fixture!;
    const [other] = await db
      .insert(schema.users)
      .values({ email: `tr-other-${randomUUID().slice(0, 8)}@scani.local`, name: 'Other' })
      .returning();
    if (!other) throw new Error('user insert failed');
    try {
      await insertOutflow(f, {
        at: anchor(),
        externalId: 'rule-6',
        rawPayload: { to: RULE_ADDRESS },
      });
      await addRule(f, {
        address: RULE_ADDRESS,
        verdict: 'not_a_disposal',
        userId: other.id,
      });

      expect((await service().pendingSummary(f.userId)).count).toBe(1);
      expect(await service().listHiddenByRule(f.userId)).toEqual([]);
    } finally {
      await db.delete(schema.users).where(eq(schema.users.id, other.id));
    }
  });

  test('the destination a rule matches on is the one the queue shows — column, payload or neither', async () => {
    const f = fixture!;
    // Where the destination is READ from — column first, payload second —
    // asserted to agree row for row between the TypeScript the surface renders
    // with and the SQL a rule is applied with. They exist separately so that
    // the count and the 200-row limit can be computed in the database, and
    // SC-329 is why it matters: an expression that read only the column would
    // match nothing in production, succeed, and be indistinguishable from a
    // user with no rules.
    //
    // Only the READ is compared, not the whole key. SC-381 moved the
    // normalization itself into one SQL function that the authoring path,
    // the join and the count all call, so there is no second implementation of
    // it left to drift — which is why every shape here is an address, for
    // which normalization is the identity beyond lowercasing. What a payment
    // description normalizes to is asserted in
    // `TransferReviewRuleService.test.ts`, against the same function.
    const shapes: Array<{
      externalId: string;
      payload?: Record<string, unknown>;
      column?: string;
    }> = [
      { externalId: 'agree-1', payload: { to: RULE_ADDRESS } },
      { externalId: 'agree-2', payload: { to: `  ${RULE_ADDRESS}  ` } },
      { externalId: 'agree-3', payload: { to: '' } },
      { externalId: 'agree-4', payload: { from: RULE_ADDRESS } },
      { externalId: 'agree-5', column: RULE_ADDRESS, payload: { to: RULE_LOOKALIKE } },
      { externalId: 'agree-6' },
    ];
    for (const shape of shapes) {
      await insertOutflow(f, {
        at: anchor(),
        externalId: shape.externalId,
        ...(shape.payload ? { rawPayload: shape.payload } : {}),
        ...(shape.column ? { counterparty: shape.column } : {}),
      });
    }

    const rows = await db
      .select({
        externalId: schema.holdingTransactions.externalId,
        kind: schema.holdingTransactions.kind,
        rawPayload: schema.holdingTransactions.rawPayload,
        counterparty: schema.holdingTransactions.counterparty,
        sqlAddress: counterpartyKeySql,
      })
      .from(schema.holdingTransactions)
      .where(pendingPredicate(f.userId));

    expect(rows).toHaveLength(shapes.length);
    for (const row of rows) {
      expect({
        externalId: row.externalId,
        address: row.sqlAddress,
      }).toEqual({
        externalId: row.externalId,
        address: normalizeCounterparty(
          counterpartyFromPayload(row.kind, row.rawPayload, row.counterparty)
        ),
      });
    }
  });
});

/**
 * Undoing a pairing the system has since PROVEN false (SC-378).
 *
 * The deadlock these are about: `unlinkPair` refuses an answered group and the
 * reopen script refuses a row the queue could not answer, so seven production
 * rows — `paired` answers on groups whose two legs sit on ONE holding — could
 * not be corrected BECAUSE they had been answered. The way out is not a flag
 * that skips either check. It is that a same-holding group is provably not a
 * transfer, so the answer on it is a question being withdrawn rather than a
 * judgement being overruled.
 *
 * Every test below is either that withdrawal working, or an attempt to reach
 * it from a group where it would be an ordinary overwrite.
 */
describe('TransferReviewService — withdrawing a false pairing (SC-378)', () => {
  /** Two legs of ONE holding from two DIFFERENT Solana transactions: the
   *  production artifact shape, and the only thing the gate admits. The
   *  signature is the `external_id` prefix before the first `-`. */
  async function insertSameHoldingArtifact(
    f: Fixture,
    opts: { answer?: string } = {}
  ): Promise<{ groupId: string; outId: string; inId: string }> {
    const groupId = randomUUID();
    const sig = randomUUID().replace(/-/g, '');
    const rows = await db
      .insert(schema.holdingTransactions)
      .values([
        {
          userId: f.userId,
          holdingId: f.outHoldingId,
          tokenId: f.tokenId,
          kind: 'transfer_out',
          quantity: '-100',
          occurredAt: anchor(),
          source: 'solana',
          externalId: `${sig}a-0`,
          transferGroupId: groupId,
          ...(opts.answer
            ? {
                transferReview: opts.answer,
                transferReviewedAt: new Date(),
                transferReviewSource: 'user',
              }
            : {}),
        },
        {
          userId: f.userId,
          holdingId: f.outHoldingId,
          tokenId: f.tokenId,
          kind: 'transfer_in',
          quantity: '100',
          occurredAt: anchor(),
          source: 'solana',
          externalId: `${sig}b-0`,
          transferGroupId: groupId,
        },
      ])
      .returning();
    const [out, arrival] = rows;
    if (!out || !arrival) throw new Error('artifact insert failed');
    return { groupId, outId: out.id, inId: arrival.id };
  }

  async function legsOf(userId: string, groupId: string) {
    return db
      .select({
        id: schema.holdingTransactions.id,
        holdingId: schema.holdingTransactions.holdingId,
        source: schema.holdingTransactions.source,
        externalId: schema.holdingTransactions.externalId,
        transferReview: schema.holdingTransactions.transferReview,
        transferReviewedAt: schema.holdingTransactions.transferReviewedAt,
        transferReviewSource: schema.holdingTransactions.transferReviewSource,
        transferGroupId: schema.holdingTransactions.transferGroupId,
      })
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, userId),
          eq(schema.holdingTransactions.transferGroupId, groupId)
        )
      );
  }

  test('clears the answer, frees both legs, and puts the question back', async () => {
    const f = fixture!;
    const { groupId, outId, inId } = await insertSameHoldingArtifact(f, { answer: 'paired' });

    // The deadlock, first: neither existing operation can touch this row.
    expect(await service().unlinkPair(f.userId, outId)).toEqual({ ok: false, reason: 'reviewed' });
    expect(await service().reopenPreview(f.userId, outId)).toHaveLength(0);

    const result = await service().withdrawSameHoldingPairing(f.userId, outId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unlinked.sort()).toEqual([inId, outId].sort());
      expect(result.cleared).toEqual([outId]);
    }

    expect(await legsOf(f.userId, groupId)).toHaveLength(0);
    const [row] = await db
      .select({
        transferReview: schema.holdingTransactions.transferReview,
        transferReviewedAt: schema.holdingTransactions.transferReviewedAt,
        transferReviewSource: schema.holdingTransactions.transferReviewSource,
        transferGroupId: schema.holdingTransactions.transferGroupId,
      })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, outId));
    expect(row?.transferGroupId).toBeNull();
    expect(row?.transferReview).toBeNull();
    expect(row?.transferReviewedAt).toBeNull();
    // REQUIREMENT 2. Unanswered, and the record of who made it so. No other
    // writer produces this pair: `resolve` sets a decision alongside the
    // source, `reopen` nulls both.
    expect(row?.transferReviewSource).toBe('repair');

    // REQUIREMENT 3. It is a question again — and the queue can answer it with
    // no candidate at all, which is what `left_control` and `untracked` are.
    const pending = await service().listPending(f.userId);
    const item = pending.find((p) => p.transactionId === outId);
    expect(item).toBeDefined();
    expect(item?.candidates).toHaveLength(0);
    // …and it says WHY it came back, so an answer reappearing does not read as
    // the queue having lost one.
    expect(item?.answerWithdrawnBy).toBe('repair');
    expect(await service().resolve(f.userId, outId, 'untracked')).toEqual({ ok: true });
  });

  /**
   * REQUIREMENT 1, and the test that has to fail if the scope ever leaks.
   *
   * A group spanning two holdings is a real movement whoever answered it, so
   * this is the ordinary "overwrite the user" case the gate exists to refuse.
   * Nothing about the call distinguishes it from the permitted one — same
   * method, same arguments, an answered group either way — so a `not_artifact`
   * here is the whole of the scoping.
   */
  test('refuses a REAL pairing across two holdings, however it was answered', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, {
      at: anchor(),
      quantity: '-100',
      externalId: 'wd-real',
      kind: 'transfer_out',
    });
    const inId = await insertInflow(f, { at: anchor(), quantity: '100', externalId: 'wd-real-in' });
    expect(
      await service().resolve(f.userId, outId, 'paired', { matchTransactionId: inId })
    ).toEqual({ ok: true });

    const refused = await service().withdrawSameHoldingPairing(f.userId, outId);
    expect(refused).toMatchObject({ ok: false, reason: 'not_artifact' });

    const [row] = await db
      .select({
        transferReview: schema.holdingTransactions.transferReview,
        transferGroupId: schema.holdingTransactions.transferGroupId,
      })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, outId));
    expect(row?.transferReview).toBe('paired');
    expect(row?.transferGroupId).not.toBeNull();
  });

  /** One upstream event with the wallet on both sides is a real no-op whose
   *  group id is load-bearing (SC-344) — same holding, same signature, and
   *  still refused. */
  test('refuses a same-holding group that is ONE upstream event', async () => {
    const f = fixture!;
    const groupId = randomUUID();
    const sig = randomUUID().replace(/-/g, '');
    const rows = await db
      .insert(schema.holdingTransactions)
      .values([
        {
          userId: f.userId,
          holdingId: f.outHoldingId,
          tokenId: f.tokenId,
          kind: 'transfer_out',
          quantity: '-100',
          occurredAt: anchor(),
          source: 'solana',
          externalId: `${sig}-0`,
          transferGroupId: groupId,
          transferReview: 'paired',
          transferReviewedAt: new Date(),
        },
        {
          userId: f.userId,
          holdingId: f.outHoldingId,
          tokenId: f.tokenId,
          kind: 'transfer_in',
          quantity: '100',
          occurredAt: anchor(),
          source: 'solana',
          externalId: `${sig}-1`,
          transferGroupId: groupId,
        },
      ])
      .returning();
    expect(await service().withdrawSameHoldingPairing(f.userId, rows[0]!.id)).toMatchObject({
      ok: false,
      reason: 'not_artifact',
    });
    expect(await legsOf(f.userId, groupId)).toHaveLength(2);
  });

  /** The other half of the disjointness: an artifact nobody answered has
   *  nothing to withdraw, and `unlinkPair` — which cannot clear answers — is
   *  the operation for it. */
  test('refuses an UNANSWERED artifact and leaves it to unlinkPair', async () => {
    const f = fixture!;
    const { groupId, outId } = await insertSameHoldingArtifact(f);
    expect(await service().withdrawSameHoldingPairing(f.userId, outId)).toMatchObject({
      ok: false,
      reason: 'no_answer',
    });
    expect(await legsOf(f.userId, groupId)).toHaveLength(2);
    expect((await service().unlinkPair(f.userId, outId)).ok).toBe(true);
  });

  test('is `gone` for an unpaired row, a missing one, and another user’s', async () => {
    const f = fixture!;
    const unpaired = await insertOutflow(f, {
      at: anchor(),
      quantity: '-5',
      externalId: 'wd-none',
    });
    expect(await service().withdrawSameHoldingPairing(f.userId, unpaired)).toEqual({
      ok: false,
      reason: 'gone',
    });
    expect(await service().withdrawSameHoldingPairing(f.userId, randomUUID())).toEqual({
      ok: false,
      reason: 'gone',
    });
    const { outId } = await insertSameHoldingArtifact(f, { answer: 'paired' });
    expect(await service().withdrawSameHoldingPairing(randomUUID(), outId)).toEqual({
      ok: false,
      reason: 'gone',
    });
  });

  /**
   * SC-376's rule, applied to the second write. The dry run reads
   * `sameHoldingRepairPlan` and the write reads `withdrawPairingRefusal`
   * inside its own transaction; this asserts they agree on rows a database
   * produced, not on a fixture built to match.
   */
  test('the plan names the write that succeeds, for both actions and for keep', async () => {
    const f = fixture!;
    const withKey = (
      rows: Awaited<ReturnType<typeof legsOf>>
    ): Array<{
      id: string;
      holdingId: string;
      source: string;
      eventKey: string | null;
      transferReview: string | null;
    }> =>
      rows.map((r) => ({
        id: r.id,
        holdingId: r.holdingId,
        source: r.source,
        eventKey: upstreamEventKey(r.source, r.externalId, null),
        transferReview: r.transferReview,
      }));

    const answered = await insertSameHoldingArtifact(f, { answer: 'paired' });
    const answeredPlan = sameHoldingRepairPlan(withKey(await legsOf(f.userId, answered.groupId)));
    expect(answeredPlan.action).toBe('withdraw');
    expect(answeredPlan.clears.map((l) => l.id)).toEqual([answered.outId]);
    expect((await service().withdrawSameHoldingPairing(f.userId, answered.outId)).ok).toBe(true);

    const clean = await insertSameHoldingArtifact(f);
    const cleanPlan = sameHoldingRepairPlan(withKey(await legsOf(f.userId, clean.groupId)));
    expect(cleanPlan.action).toBe('unlink');
    expect((await service().unlinkPair(f.userId, clean.outId)).ok).toBe(true);
  });
});

/**
 * Bulk apply (SC-382).
 *
 * mgrin asked for it directly, and the reason it needs this much test is not
 * the selection: it is that `left_control` is the only answer that books a
 * disposal, so a bulk apply of it books N capital gains on one tap. Every test
 * below pins one of the four gates that stand between a tap and that, or the
 * attribution that the 2026-08-14 raw UPDATE left out of 555 rows.
 */
describe('TransferReviewService — bulk apply (SC-382)', () => {
  const OWN_BULK = '0x9d8ae06a94c5592f57812e0f045438602a7e14ab';

  async function answersOf(ids: string[]) {
    const rows = await db
      .select({
        id: schema.holdingTransactions.id,
        review: schema.holdingTransactions.transferReview,
        source: schema.holdingTransactions.transferReviewSource,
        reviewedAt: schema.holdingTransactions.transferReviewedAt,
        groupId: schema.holdingTransactions.transferGroupId,
      })
      .from(schema.holdingTransactions)
      .where(inArray(schema.holdingTransactions.id, ids));
    return new Map(rows.map((r) => [r.id, r]));
  }

  const asks = (ids: string[], decision: 'left_control' | 'untracked' | null) =>
    ids.map((transactionId) => ({ transactionId, decision }));

  test('writes every row and stamps each one as the user’s own answer', async () => {
    const f = fixture!;
    const ids = await Promise.all([
      insertOutflow(f, { at: anchor(), externalId: 'bulk-a1' }),
      insertOutflow(f, { at: anchor(), externalId: 'bulk-a2' }),
      insertOutflow(f, { at: anchor(), externalId: 'bulk-a3' }),
    ]);

    const result = await service().bulkResolve(f.userId, asks(ids, 'left_control'));
    expect(result.ok).toBe(true);

    const after = await answersOf(ids);
    for (const id of ids) {
      const row = after.get(id);
      expect(row?.review).toBe('left_control');
      // The whole reason this is a service method: 56.4% of production's
      // answers carry neither of these two columns, and a bulk path that
      // wrote without them would be the 2026-08-14 UPDATE with a button on it.
      expect(row?.source).toBe('user');
      expect(row?.reviewedAt).not.toBeNull();
    }
    expect((await service().listPending(f.userId)).length).toBe(0);
  });

  test('returns the answer it replaced on every row, and that list undoes it exactly', async () => {
    const f = fixture!;
    const never = await insertOutflow(f, { at: anchor(), externalId: 'bulk-u1' });
    const wasUntracked = await insertOutflow(f, {
      at: anchor(),
      externalId: 'bulk-u2',
      transferReview: 'untracked',
      transferReviewSource: 'user',
      transferReviewedAt: anchor(),
    });

    const applied = await service().bulkResolve(
      f.userId,
      asks([never, wasUntracked], 'left_control')
    );
    if (!applied.ok) throw new Error('expected the batch to apply');
    expect(new Map(applied.applied.map((a) => [a.transactionId, a.previous]))).toEqual(
      new Map([
        [never, null],
        [wasUntracked, 'untracked'],
      ])
    );

    // The undo IS the return value handed straight back, through the one
    // helper that turns the output shape into the input shape.
    const undone = await service().bulkResolve(f.userId, undoEntriesFor(applied.applied));
    expect(undone.ok).toBe(true);

    const after = await answersOf([never, wasUntracked]);
    // Back in the queue, with no residue: `transfer_review_source` null too,
    // because the user took their own answer back and nothing is owed to a
    // later reader (this is `reopen`'s attribution, not a repair's).
    expect(after.get(never)?.review).toBeNull();
    expect(after.get(never)?.source).toBeNull();
    expect(after.get(never)?.reviewedAt).toBeNull();
    expect(after.get(wasUntracked)?.review).toBe('untracked');
    expect(after.get(wasUntracked)?.source).toBe('user');
  });

  test('refuses a row the matcher has linked — the gate the answer column does not imply', async () => {
    const f = fixture!;
    const free = await insertOutflow(f, { at: anchor(), externalId: 'bulk-l1' });
    // Unanswered AND carrying a group id: invisible to the queue, and
    // `outflowPortions` reads `transferGroupId` before `isConfirmedDisposal`,
    // so a `left_control` written here would book nothing while reading as
    // answered. 29 of production's unanswered outflows are in this state.
    const linked = await insertOutflow(f, {
      at: anchor(),
      externalId: 'bulk-l2',
      transferGroupId: randomUUID(),
    });

    const result = await service().bulkResolve(f.userId, asks([free, linked], 'left_control'));
    if (result.ok) throw new Error('expected a refusal');
    expect(result.refusals).toEqual([{ transactionId: linked, reason: 'linked', detail: null }]);

    // All or nothing: the row that WAS eligible is untouched.
    expect((await answersOf([free])).get(free)?.review).toBeNull();
  });

  test('refuses a paired, an internal and a split row, naming the answer in the way', async () => {
    const f = fixture!;
    const split = await insertOutflow(f, {
      at: anchor(),
      externalId: 'bulk-s1',
      transferReview: 'split',
    });
    const result = await service().bulkResolve(f.userId, asks([split], 'untracked'));
    if (result.ok) throw new Error('expected a refusal');
    expect(result.refusals).toEqual([
      { transactionId: split, reason: 'answered_otherwise', detail: 'split' },
    ]);
  });

  test('refuses left_control onto the caller’s own wallet, and allows untracked onto it', async () => {
    const f = fixture!;
    await db
      .insert(schema.userWallets)
      .values({ userId: f.userId, walletAddress: OWN_BULK, institutionIds: [] });
    const id = await insertOutflow(f, {
      at: anchor(),
      externalId: 'bulk-w1',
      kind: 'transfer_out',
      rawPayload: { to: OWN_BULK, hash: '0xbulk' },
    });

    const refused = await service().bulkResolve(f.userId, asks([id], 'left_control'));
    if (refused.ok) throw new Error('expected the own-wallet refusal');
    expect(refused.refusals).toEqual([
      { transactionId: id, reason: 'own_wallet', detail: OWN_BULK },
    ]);

    // `untracked` is the answer the reader actually means for this row, and it
    // books nothing — so it is not gated.
    expect((await service().bulkResolve(f.userId, asks([id], 'untracked'))).ok).toBe(true);
  });

  test('refuses another user’s transfer without saying it exists', async () => {
    const f = fixture!;
    const mine = await insertOutflow(f, { at: anchor(), externalId: 'bulk-x1' });
    const stranger = randomUUID();

    const result = await service().bulkResolve(f.userId, asks([mine, stranger], 'left_control'));
    if (result.ok) throw new Error('expected a refusal');
    expect(result.refusals).toEqual([{ transactionId: stranger, reason: 'gone', detail: null }]);
    expect((await answersOf([mine])).get(mine)?.review).toBeNull();
  });

  test('refuses a zero-quantity row — the address-poisoning corpus', async () => {
    const f = fixture!;
    const zero = await insertOutflow(f, {
      at: anchor(),
      externalId: 'bulk-z1',
      quantity: '0',
      kind: 'transfer_out',
    });
    const result = await service().bulkResolve(f.userId, asks([zero], 'left_control'));
    if (result.ok) throw new Error('expected a refusal');
    expect(result.refusals[0]?.reason).toBe('gone');
  });

  test('preview counts the money over the eligible rows and names the refusals', async () => {
    const f = fixture!;
    const ok1 = await insertOutflow(f, { at: anchor(), externalId: 'bulk-p1' });
    const ok2 = await insertOutflow(f, {
      at: anchor(),
      externalId: 'bulk-p2',
      transferReview: 'left_control',
    });
    const linked = await insertOutflow(f, {
      at: anchor(),
      externalId: 'bulk-p3',
      transferGroupId: randomUUID(),
    });

    const preview = await service().bulkPreview(f.userId, [ok1, ok2, linked], 'untracked');
    expect(preview.eligible).toEqual([ok1, ok2]);
    expect(preview.refusals).toEqual([{ transactionId: linked, reason: 'linked', detail: null }]);
    // The row that already books a disposal is reported on its own, because
    // answering it `untracked` takes that gain back OFF — the direction the
    // 219 production rows need, and the one a confirmation that only ever
    // describes additions would be silent about.
    expect(preview.alreadyDisposedCount).toBe(1);
    // No price graph in this fixture, so every eligible row is unpriced —
    // which is reported rather than folded into the total as a zero.
    expect(preview.unpricedCount).toBe(2);
    expect(preview.proceedsInBase).toBeNull();
    expect(preview.alreadyDisposedInBase).toBeNull();
  });

  test('preview only refuses an own wallet when the target is the disposal', async () => {
    const f = fixture!;
    await db
      .insert(schema.userWallets)
      .values({ userId: f.userId, walletAddress: OWN_BULK, institutionIds: [] });
    const id = await insertOutflow(f, {
      at: anchor(),
      externalId: 'bulk-p4',
      kind: 'transfer_out',
      rawPayload: { to: OWN_BULK, hash: '0xbulk2' },
    });

    expect((await service().bulkPreview(f.userId, [id], 'left_control')).refusals).toHaveLength(1);
    expect((await service().bulkPreview(f.userId, [id], 'untracked')).refusals).toEqual([]);
    expect((await service().bulkPreview(f.userId, [id], null)).refusals).toEqual([]);
  });
});

/**
 * The ownership boundary, at the surface that OFFERS a pairing (SC-463).
 *
 * This block is the reason the guard went into `candidatePairClass` rather
 * than into `LinkTransferPairsUseCase`. A linker-only guard passes every test
 * about the linker and leaves this surface recommending the same wrong pairing
 * with an accept action beside it — and a pairing a reader completes carries
 * `answerSource: 'user'`, which every downstream consumer trusts MORE than a
 * machine match. Stopping the machine while leaving the machine's
 * recommendation standing launders the error through approval.
 *
 * Money crossing between the owner's books and their company's is a real event
 * on both sets — a director's loan, a dividend, a salary — so it must be
 * classified, not paired.
 */
describe('TransferReviewService — the entity boundary', () => {
  async function makeEntity(userId: string, name: string): Promise<string> {
    const [row] = await db
      .insert(schema.entities)
      .values({ userId, name: `${name}-${randomUUID().slice(0, 6)}` })
      .returning();
    if (!row) throw new Error('entity insert failed');
    return row.id;
  }

  async function putAccountInEntity(accountId: string, entityId: string | null): Promise<void> {
    await db.update(schema.accounts).set({ entityId }).where(eq(schema.accounts.id, accountId));
  }

  /**
   * The must-be-FOUND control, run first and deliberately not folded into the
   * refusal test. It establishes that this fixture produces a candidate at all
   * — without it, a predicate that refused everything would make the assertion
   * below pass while proving nothing.
   */
  test('still offers a candidate when both accounts are in the SAME entity', async () => {
    const f = fixture!;
    const at = anchor();
    const personal = await makeEntity(f.userId, 'personal');
    await putAccountInEntity(f.outAccountId, personal);
    await putAccountInEntity(f.inAccountId, personal);

    await insertOutflow(f, { at, externalId: 'ent-ctl-1' });
    await insertInflow(f, {
      at: new Date(at.getTime() + 5 * 60_000),
      quantity: '0.999',
      externalId: 'ent-ctl-in-1',
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.candidates).toHaveLength(1);
  });

  test('offers NO candidate across the boundary — the queue cannot recommend what the matcher refuses', async () => {
    const f = fixture!;
    const at = anchor();
    await putAccountInEntity(f.outAccountId, await makeEntity(f.userId, 'personal'));
    await putAccountInEntity(f.inAccountId, await makeEntity(f.userId, 'company'));

    await insertOutflow(f, { at, externalId: 'ent-1' });
    await insertInflow(f, {
      at: new Date(at.getTime() + 5 * 60_000),
      quantity: '0.999',
      externalId: 'ent-in-1',
    });

    const [item] = await service().listPending(f.userId);
    // The outflow is still a QUESTION — it stays in the queue for its owner to
    // classify. What it must not have is a recommended answer.
    expect(item).toBeDefined();
    expect(item?.candidates).toEqual([]);
  });

  /**
   * An account nobody has classified is outside every boundary, so a movement
   * between it and an assigned one crosses one. The second assertion is the
   * one that matters most: null matches null, so nothing changes for a
   * portfolio whose owner has drawn no boundary — which is every portfolio
   * until they draw one.
   */
  test('assigned-to-unassigned is refused; unassigned-to-unassigned is untouched', async () => {
    const f = fixture!;
    const at = anchor();
    await putAccountInEntity(f.outAccountId, await makeEntity(f.userId, 'company'));
    await putAccountInEntity(f.inAccountId, null);

    await insertOutflow(f, { at, externalId: 'ent-2' });
    await insertInflow(f, {
      at: new Date(at.getTime() + 5 * 60_000),
      quantity: '0.999',
      externalId: 'ent-in-2',
    });
    expect((await service().listPending(f.userId))[0]?.candidates).toEqual([]);

    // Both unassigned — the state every existing portfolio is in today.
    await putAccountInEntity(f.outAccountId, null);
    expect((await service().listPending(f.userId))[0]?.candidates).toHaveLength(1);
  });
});

/**
 * Reopening a transfer the OWNER declared (SC-618).
 *
 * ## Why these assert balances and not the link
 *
 * The defect is invisible to every assertion about rows. Measured before the
 * fix: declaring 2000 out of a holding at 4000 into one at 500 left them at
 * 2000 and 2500, `reopen` returned `true`, both legs survived with
 * `transfer_group_id` NULL — and the two balances did not move. A test
 * asserting "the pair is unlinked" passes against that, because unlinking is
 * the one thing the bug did correctly.
 *
 * So the assertion is the number a person would see on the dashboard: 500
 * again, and 4000 again. Money that has moved with nothing saying why is the
 * whole of what was wrong.
 *
 * ## Two paths, opposite requirements — and both controls are here
 *
 * `writeInflow` (the queue) deliberately does NOT move an existing
 * destination's balance: the arrival was already observed by whatever imported
 * it, and moving it would double-count. `UpdateHoldingUseCase.moveDeclaredTransfer`
 * (declared) DOES move both anchors, because the owner is the only source of
 * truth for both sides. Undoing one must not undo the other, so:
 *
 * - a **must-be-ABSENT** control: a queue answer whose two legs are BOTH
 *   hand-entered balance edits, made at different instants, is NOT a declared
 *   pair and reopening it must move no balance. This is the case a
 *   discriminator reading `source = 'user-balance-edit'` alone gets wrong.
 * - a **must-be-FOUND** control: the declared pair itself, which must be
 *   undone.
 */
describe('TransferReviewService — reopening a transfer the OWNER declared (SC-618)', () => {
  async function setBalance(holdingId: string, balance: string): Promise<void> {
    await db.update(schema.holdings).set({ balance }).where(eq(schema.holdings.id, holdingId));
  }

  async function balance(holdingId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ balance: schema.holdings.balance })
      .from(schema.holdings)
      .where(eq(schema.holdings.id, holdingId));
    return row?.balance;
  }

  async function ledgerRows(f: Fixture) {
    return await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
  }

  async function observationCount(holdingId: string): Promise<number> {
    const rows = await db
      .select({ id: schema.holdingBalanceObservations.id })
      .from(schema.holdingBalanceObservations)
      .where(eq(schema.holdingBalanceObservations.holdingId, holdingId));
    return rows.length;
  }

  /** "I moved `amount` from the source holding to the destination holding." */
  async function declare(
    f: Fixture,
    amount: string
  ): Promise<{ outflowId: string; inflowId: string }> {
    await new RecordHoldingMovementUseCase().execute(
      {
        holdingId: f.outHoldingId,
        direction: 'transfer',
        amount,
        occurredAt: anchor().toISOString(),
        destinationAccountId: f.inAccountId,
        destinationHoldingId: f.inHoldingId,
      },
      f.userId
    );
    const rows = await ledgerRows(f);
    const outflowId = rows.find((r) => r.holdingId === f.outHoldingId)?.id;
    const inflowId = rows.find((r) => r.holdingId === f.inHoldingId)?.id;
    if (!outflowId || !inflowId) throw new Error('declared transfer did not write two legs');
    return { outflowId, inflowId };
  }

  test('the destination goes back to what it was, and so does the source', async () => {
    const f = fixture!;
    await setBalance(f.outHoldingId, '4000');
    await setBalance(f.inHoldingId, '500');

    const { outflowId } = await declare(f, '2000');
    // The declaration itself, on the number a person would see.
    expect(await balance(f.outHoldingId)).toBe('2000');
    expect(await balance(f.inHoldingId)).toBe('2500');

    expect(await service().reopen(f.userId, outflowId)).toBe(true);

    // The whole of the defect. Before the fix both of these read 2000 and
    // 2500 — the money stayed moved and the link that explained it was gone.
    expect(await balance(f.outHoldingId)).toBe('4000');
    expect(await balance(f.inHoldingId)).toBe('500');
  });

  test('both legs are gone — no ungrouped deposit is left to open a fresh lot', async () => {
    const f = fixture!;
    await setBalance(f.outHoldingId, '4000');
    await setBalance(f.inHoldingId, '500');
    const { outflowId } = await declare(f, '2000');
    expect(await ledgerRows(f)).toHaveLength(2);

    await service().reopen(f.userId, outflowId);

    // Leaving the deposit behind ungrouped is what invents the gain:
    // `CostBasisService.walkComponent` inherits buffered lots only across a
    // shared `transfer_group_id`, so an orphaned arrival opens a fresh lot at
    // market. Deleting it is the point, not tidiness.
    expect(await ledgerRows(f)).toHaveLength(0);
    // And the withdrawal does not come back as a question, because there is
    // no withdrawal any more.
    expect((await service().pendingSummary(f.userId)).count).toBe(0);
  });

  test('a restored anchor is observed, so history is not reconstructed from a gap', async () => {
    const f = fixture!;
    await setBalance(f.outHoldingId, '4000');
    await setBalance(f.inHoldingId, '500');
    const { outflowId } = await declare(f, '2000');
    const before = {
      out: await observationCount(f.outHoldingId),
      in: await observationCount(f.inHoldingId),
    };

    await service().reopen(f.userId, outflowId);

    // SC-245: a balance mutation with no observation does not degrade
    // `BalanceAtTimeService`, it makes it confidently wrong on every date
    // after the gap.
    expect(await observationCount(f.outHoldingId)).toBe(before.out + 1);
    expect(await observationCount(f.inHoldingId)).toBe(before.in + 1);
  });

  test('a queue answer restores the DESTINATION only — the source was imported', async () => {
    const f = fixture!;
    await setBalance(f.inHoldingId, '500');
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-2000', externalId: 'd-1' });
    await service().resolve(f.userId, outId, 'internal', {
      destination: { accountId: f.inAccountId, holdingId: f.inHoldingId },
    });
    // Nobody syncs this destination, so `writeInflow` moved its anchor
    // (SC-856). Before that it wrote the arrival and left the 500 alone.
    expect(await balance(f.inHoldingId)).toBe('2500');

    expect(await service().reopen(f.userId, outId)).toBe(true);

    // Back where it was — otherwise reopening leaves the money moved with the
    // link that explained it gone, which is the SC-618 shape on the queue.
    expect(await balance(f.inHoldingId)).toBe('500');
    // The SOURCE is untouched on both halves. Its withdrawal came from an
    // import and no answer here ever moved it, so there is nothing to restore
    // — the asymmetry with a declared transfer, which moved both.
    expect(await balance(f.outHoldingId)).toBe('0');
    // The outflow is a question again, which is what reopen means here.
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('two hand-entered edits the QUEUE paired are not a declared pair', async () => {
    const f = fixture!;
    await setBalance(f.outHoldingId, '4000');
    await setBalance(f.inHoldingId, '500');

    // Two separate balance edits, two different edit instants, later joined by
    // the queue. Both legs carry `source = 'user-balance-edit'`, which is why
    // a discriminator reading the source alone would undo them — and undoing
    // them would move two balances the user set by hand and never asked to
    // have moved.
    const [outflow] = await db
      .insert(schema.holdingTransactions)
      .values({
        userId: f.userId,
        holdingId: f.outHoldingId,
        tokenId: f.tokenId,
        kind: 'withdraw',
        quantity: '-2000',
        occurredAt: anchor(),
        source: 'user-balance-edit',
        externalId: 'manual-edit:2026-08-01T10:00:00.000Z',
      })
      .returning();
    const [inflow] = await db
      .insert(schema.holdingTransactions)
      .values({
        userId: f.userId,
        holdingId: f.inHoldingId,
        tokenId: f.tokenId,
        kind: 'deposit',
        quantity: '2000',
        occurredAt: anchor(),
        source: 'user-balance-edit',
        externalId: 'manual-edit:2026-08-02T11:30:00.000Z',
      })
      .returning();
    if (!outflow || !inflow) throw new Error('leg insert failed');

    expect(
      await service().resolve(f.userId, outflow.id, 'paired', { matchTransactionId: inflow.id })
    ).toEqual({ ok: true });

    expect(await service().reopen(f.userId, outflow.id)).toBe(true);

    // Nothing moved, and both rows survive: the user entered each of these
    // balances themselves, and reopening the pairing is a statement about the
    // LINK, not about either balance.
    expect(await balance(f.outHoldingId)).toBe('4000');
    expect(await balance(f.inHoldingId)).toBe('500');
    expect(await ledgerRows(f)).toHaveLength(2);
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });
});

/**
 * SC-641. `writeInflow` opened its destination with a direct
 * `tx.insert(schema.holdings)` and recorded no balance observation, while
 * `HoldingService.createHoldingWithEvent` — the path every other creator uses
 * — records one. SC-245's shape in a path SC-245 never reached, and
 * `HoldingService`'s own docblock predicted it: *"nothing stops the next
 * caller writing `holdings` directly."*
 *
 * The two branches are treated DIFFERENTLY on purpose, and the last test here
 * is why rather than a comment claiming it.
 */
describe('TransferReviewService — the opening observation of a holding it created', () => {
  async function observationsOn(holdingId: string) {
    return db
      .select()
      .from(schema.holdingBalanceObservations)
      .where(eq(schema.holdingBalanceObservations.holdingId, holdingId));
  }

  async function createdHoldingIn(f: Fixture, accountId: string) {
    const [row] = await db
      .select()
      .from(schema.holdings)
      .where(
        and(
          eq(schema.holdings.userId, f.userId),
          eq(schema.holdings.accountId, accountId),
          eq(schema.holdings.tokenId, f.tokenId)
        )
      );
    return row;
  }

  test('a destination nobody syncs is opened WITH an observation of the opening', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-250', externalId: 's641-1' });
    expect(
      await service().resolve(f.userId, outId, 'internal', {
        destination: { accountId: f.emptyAccountId, holdingId: null },
      })
    ).toEqual({ ok: true });

    const holding = await createdHoldingIn(f, f.emptyAccountId);
    expect(holding?.balance).toBe('250');

    // The whole of SC-641: 250 appeared and nothing recorded that it had.
    const obs = await observationsOn(holding?.id ?? '');
    expect(obs).toHaveLength(1);
    expect(obs[0]?.balance).toBe('250');
  });

  test('the opening observation is marked as an opening, not as a capture', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-250', externalId: 's641-2' });
    await service().resolve(f.userId, outId, 'internal', {
      destination: { accountId: f.emptyAccountId, holdingId: null },
    });

    const holding = await createdHoldingIn(f, f.emptyAccountId);
    const obs = await observationsOn(holding?.id ?? '');
    // Load-bearing, not cosmetic. `holdingIsUntouched` (SC-631) reads an
    // observation as evidence a person touched the row, and excludes THIS
    // source on the ground that it records nothing beyond the holding's own
    // existence. Change the string here and SC-631 stops deleting anything.
    expect(obs[0]?.source).toBe(HOLDING_OPEN_OBSERVATION_SOURCE);
    // And it is not the vocabulary a sync uses, because no sync captured it.
    expect(obs[0]?.source).not.toBe('sync-capture');
  });

  test('a SYNC-OWNED destination is opened with NO observation', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-1000', externalId: 's641-3' });
    expect(
      await service().resolve(f.userId, outId, 'internal', {
        destination: { accountId: f.walletSyncedAccountId, holdingId: null },
      })
    ).toEqual({ ok: true });

    const holding = await createdHoldingIn(f, f.walletSyncedAccountId);
    expect(holding?.balance).toBe('0');
    // Deliberate asymmetry. The next test is the reason.
    expect(await observationsOn(holding?.id ?? '')).toEqual([]);
  });

  test('opening a sync-owned row with an observation would invent a gap the ledger cannot explain', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-1000', externalId: 's641-4' });
    await service().resolve(f.userId, outId, 'internal', {
      destination: { accountId: f.walletSyncedAccountId, holdingId: null },
    });
    const holding = await createdHoldingIn(f, f.walletSyncedAccountId);
    const holdingId = holding?.id ?? '';

    // The sync's first pass, an hour later, reporting the arrival.
    await db.insert(schema.holdingBalanceObservations).values({
      userId: f.userId,
      holdingId,
      balance: '1000',
      observedAt: new Date(Date.now() + 60 * 60 * 1000),
      source: 'sync-capture',
    });

    // No gap: `findGapCandidatesForUser` needs a PAIR, and the sync
    // observation is the first one on this holding.
    const clean = await Container.get(HoldingBalanceObservationRepository).findGapCandidatesForUser(
      f.userId
    );
    expect(clean.filter((c) => c.holdingId === holdingId)).toEqual([]);

    // Now write the opening observation this path deliberately does NOT write,
    // and the pair appears. `bridge` sums transactions with
    // `occurred_at > previous_observed_at`, and the arrival is dated at the
    // TRANSFER's time — before the opening — so it falls outside the interval
    // and explains nothing. The owner would be asked to account for 1000 that
    // the ledger already accounts for.
    await db.insert(schema.holdingBalanceObservations).values({
      userId: f.userId,
      holdingId,
      balance: '0',
      observedAt: new Date(Date.now() - 60 * 1000),
      source: HOLDING_OPEN_OBSERVATION_SOURCE,
    });
    const invented = await Container.get(
      HoldingBalanceObservationRepository
    ).findGapCandidatesForUser(f.userId);
    const mine = invented.filter((c) => c.holdingId === holdingId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.explained).toBe('0');
    expect(mine[0]?.balance).toBe('1000');
    expect(mine[0]?.previousBalance).toBe('0');
  });
});
