/**
 * `LinkTransferPairsUseCase` integration tests.
 *
 * Note on test isolation: this use case (and the other PnL nightly-cron
 * use cases) calls the global `db` connection directly rather than
 * accepting an injected transaction, so the standard `withTestDb`
 * rollback wrapper can't isolate the writes. Instead we:
 *
 *   - Create a fresh user per test (random email via `makeUser`-style
 *     direct insert) so the use case's `userId` filter scopes naturally.
 *   - Use `afterEach` to delete every row we inserted (cascading from
 *     `users` cleans up holdings, transactions, and accounts).
 *
 * This pattern keeps tests isolated without needing changes to the use
 * case's data-access shape.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { TransferReviewService } from '../../src/services/TransferReviewService';
import { LinkTransferPairsUseCase } from '../../src/use-cases/LinkTransferPairsUseCase';

interface Fixture {
  userId: string;
  withdrawAccountId: string;
  depositAccountId: string;
  tokenId: string;
  withdrawHoldingId: string;
  depositHoldingId: string;
  // Lookup-table row ids — explicitly tracked so cleanupFixture can
  // remove them too. They don't FK to user, so cascade-deleting the
  // user leaves them behind and pollutes the dev DB across runs.
  institutionTypeId: string;
  institutionId: string;
  accountTypeId: string;
  tokenTypeId: string;
}

let fixture: Fixture | null = null;

// LinkTransferPairsUseCase only scans the last ~2 years of transactions
// (its `since` window). Anchor fixtures relative to now so they never age
// out of that window and silently report scanned=0 — a previously
// hardcoded 2024 date started failing once the calendar passed it.
function recentTransferTimestamp(): Date {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

async function setupFixture(): Promise<Fixture> {
  // Insert a user, two accounts (one CEX, one wallet), a token, and a
  // holding per account. The use case scans by user, so the institution
  // shape doesn't matter — we just need two distinct accounts.
  const [user] = await db
    .insert(schema.users)
    .values({ email: `link-${randomUUID().slice(0, 8)}@scani.local`, name: 'LinkTest' })
    .returning();
  if (!user) throw new Error('user insert failed');

  // institution_types + institutions are required by accounts.
  const [instType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `lt-${randomUUID().slice(0, 6)}`, name: 'LinkTest Type' })
    .returning();
  if (!instType) throw new Error('instType insert failed');
  const [inst] = await db
    .insert(schema.institutions)
    .values({ name: `LT-${randomUUID().slice(0, 6)}`, typeId: instType.id })
    .returning();
  if (!inst) throw new Error('inst insert failed');
  const [acctType] = await db
    .insert(schema.accountTypes)
    .values({ code: `lt-acct-${randomUUID().slice(0, 6)}`, name: 'LinkTest Account' })
    .returning();
  if (!acctType) throw new Error('acctType insert failed');

  const [withdrawAccount] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: inst.id,
      typeId: acctType.id,
      name: `withdraw-${randomUUID().slice(0, 6)}`,
    })
    .returning();
  const [depositAccount] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: inst.id,
      typeId: acctType.id,
      name: `deposit-${randomUUID().slice(0, 6)}`,
    })
    .returning();
  if (!withdrawAccount || !depositAccount) throw new Error('account insert failed');

  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `lt-tok-${randomUUID().slice(0, 6)}`, name: 'LinkTest Token Type' })
    .returning();
  if (!tokenType) throw new Error('tokenType insert failed');
  const [token] = await db
    .insert(schema.tokens)
    .values({
      symbol: `LT${randomUUID().toUpperCase()}`,
      name: 'LinkTest Token',
      typeId: tokenType.id,
    })
    .returning();
  if (!token) throw new Error('token insert failed');

  const [withdrawHolding] = await db
    .insert(schema.holdings)
    .values({
      userId: user.id,
      accountId: withdrawAccount.id,
      tokenId: token.id,
      balance: '0',
    })
    .returning();
  const [depositHolding] = await db
    .insert(schema.holdings)
    .values({
      userId: user.id,
      accountId: depositAccount.id,
      tokenId: token.id,
      balance: '1',
    })
    .returning();
  if (!withdrawHolding || !depositHolding) throw new Error('holding insert failed');

  return {
    userId: user.id,
    withdrawAccountId: withdrawAccount.id,
    depositAccountId: depositAccount.id,
    tokenId: token.id,
    withdrawHoldingId: withdrawHolding.id,
    depositHoldingId: depositHolding.id,
    institutionTypeId: instType.id,
    institutionId: inst.id,
    accountTypeId: acctType.id,
    tokenTypeId: tokenType.id,
  };
}

async function cleanupFixture(f: Fixture): Promise<void> {
  // Cascade delete: dropping the user removes accounts, holdings,
  // and holding_transactions via FK cascade. The lookup-table rows
  // (account_types / institution_types / token_types / institutions /
  // tokens) don't FK to user, so we delete them explicitly in
  // dependency order — leaving them behind across thousands of test
  // runs would otherwise pollute the dev DB enum dropdowns.
  await db.delete(schema.users).where(eq(schema.users.id, f.userId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, f.tokenId));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
  await db
    .delete(schema.institutionTypes)
    .where(eq(schema.institutionTypes.id, f.institutionTypeId));
}

beforeEach(async () => {
  fixture = await setupFixture();
});

afterEach(async () => {
  if (fixture) await cleanupFixture(fixture);
  fixture = null;
});

describe('LinkTransferPairsUseCase', () => {
  test('throws when called without a userId', async () => {
    const uc = Container.get(LinkTransferPairsUseCase);
    await expect(uc.execute({ userId: '' })).rejects.toThrow(/requires userId/);
  });

  test('returns zero results when there are no eligible withdraw/deposit pairs', async () => {
    const f = fixture!;
    const uc = Container.get(LinkTransferPairsUseCase);
    const summary = await uc.execute({ userId: f.userId });
    expect(summary.scanned).toBe(0);
    expect(summary.linked).toBe(0);
    expect(summary.ambiguous).toBe(0);
  });

  test('links a single matching withdraw/deposit pair within window + epsilon', async () => {
    const f = fixture!;
    const at = recentTransferTimestamp();
    await db.insert(schema.holdingTransactions).values([
      {
        userId: f.userId,
        holdingId: f.withdrawHoldingId,
        tokenId: f.tokenId,
        kind: 'withdraw',
        quantity: '-1.0',
        occurredAt: at,
        source: 'kraken-api',
        externalId: 'k-w-1',
      },
      {
        userId: f.userId,
        holdingId: f.depositHoldingId,
        tokenId: f.tokenId,
        kind: 'deposit',
        // ~0.5% drift — within the 1% epsilon.
        quantity: '0.995',
        occurredAt: new Date(at.getTime() + 5 * 60 * 1000),
        source: 'etherscan',
        externalId: 'e-d-1',
      },
    ]);

    const uc = Container.get(LinkTransferPairsUseCase);
    const summary = await uc.execute({ userId: f.userId });
    expect(summary.scanned).toBe(1);
    expect(summary.linked).toBe(1);
    expect(summary.ambiguous).toBe(0);

    const rows = await db
      .select({
        id: schema.holdingTransactions.id,
        kind: schema.holdingTransactions.kind,
        groupId: schema.holdingTransactions.transferGroupId,
      })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    expect(rows).toHaveLength(2);
    const groupIds = new Set(rows.map((r) => r.groupId));
    expect(groupIds.size).toBe(1);
    expect([...groupIds][0]).not.toBeNull();
  });

  test('does NOT link when the deposit is outside the 30-min match window', async () => {
    const f = fixture!;
    const at = recentTransferTimestamp();
    await db.insert(schema.holdingTransactions).values([
      {
        userId: f.userId,
        holdingId: f.withdrawHoldingId,
        tokenId: f.tokenId,
        kind: 'withdraw',
        quantity: '-1.0',
        occurredAt: at,
        source: 'kraken-api',
        externalId: 'k-w-2',
      },
      {
        userId: f.userId,
        holdingId: f.depositHoldingId,
        tokenId: f.tokenId,
        kind: 'deposit',
        quantity: '1.0',
        // 1 hour after — outside the 30-min window.
        occurredAt: new Date(at.getTime() + 60 * 60 * 1000),
        source: 'etherscan',
        externalId: 'e-d-2',
      },
    ]);
    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: f.userId });
    expect(summary.scanned).toBe(1);
    expect(summary.linked).toBe(0);
  });

  test('does NOT link when quantity drift exceeds the 1% epsilon', async () => {
    const f = fixture!;
    const at = recentTransferTimestamp();
    await db.insert(schema.holdingTransactions).values([
      {
        userId: f.userId,
        holdingId: f.withdrawHoldingId,
        tokenId: f.tokenId,
        kind: 'withdraw',
        quantity: '-1.0',
        occurredAt: at,
        source: 'kraken-api',
        externalId: 'k-w-3',
      },
      {
        userId: f.userId,
        holdingId: f.depositHoldingId,
        tokenId: f.tokenId,
        kind: 'deposit',
        // 5% drift — clearly above 1%.
        quantity: '0.95',
        occurredAt: new Date(at.getTime() + 5 * 60 * 1000),
        source: 'etherscan',
        externalId: 'e-d-3',
      },
    ]);
    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: f.userId });
    expect(summary.scanned).toBe(1);
    expect(summary.linked).toBe(0);
  });

  test('flags ambiguous pairs when more than one viable deposit matches', async () => {
    const f = fixture!;
    const at = recentTransferTimestamp();
    await db.insert(schema.holdingTransactions).values([
      {
        userId: f.userId,
        holdingId: f.withdrawHoldingId,
        tokenId: f.tokenId,
        kind: 'withdraw',
        quantity: '-1.0',
        occurredAt: at,
        source: 'kraken-api',
        externalId: 'k-w-4',
      },
      // Two viable candidate deposits within window + epsilon.
      {
        userId: f.userId,
        holdingId: f.depositHoldingId,
        tokenId: f.tokenId,
        kind: 'deposit',
        quantity: '1.0',
        occurredAt: new Date(at.getTime() + 5 * 60 * 1000),
        source: 'etherscan',
        externalId: 'e-d-4a',
      },
      {
        userId: f.userId,
        holdingId: f.depositHoldingId,
        tokenId: f.tokenId,
        kind: 'deposit',
        quantity: '1.0',
        occurredAt: new Date(at.getTime() + 10 * 60 * 1000),
        source: 'etherscan',
        externalId: 'e-d-4b',
      },
    ]);
    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: f.userId });
    expect(summary.scanned).toBe(1);
    expect(summary.linked).toBe(0);
    expect(summary.ambiguous).toBe(1);
    // No transferGroupId set on either candidate.
    const rows = await db
      .select({ groupId: schema.holdingTransactions.transferGroupId })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    expect(rows.every((r) => r.groupId === null)).toBe(true);
  });

  test('skips rows already carrying a transferGroupId (idempotent re-run)', async () => {
    const f = fixture!;
    const at = recentTransferTimestamp();
    const preLinkedGroup = randomUUID();
    await db.insert(schema.holdingTransactions).values([
      {
        userId: f.userId,
        holdingId: f.withdrawHoldingId,
        tokenId: f.tokenId,
        kind: 'withdraw',
        quantity: '-1.0',
        occurredAt: at,
        source: 'kraken-api',
        externalId: 'k-w-5',
        transferGroupId: preLinkedGroup,
      },
      {
        userId: f.userId,
        holdingId: f.depositHoldingId,
        tokenId: f.tokenId,
        kind: 'deposit',
        quantity: '1.0',
        occurredAt: new Date(at.getTime() + 5 * 60 * 1000),
        source: 'etherscan',
        externalId: 'e-d-5',
        transferGroupId: preLinkedGroup,
      },
    ]);
    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: f.userId });
    // Both rows are already linked; the use case's WHERE filter on
    // `transferGroupId IS NULL` excludes them — scanned=0.
    expect(summary.scanned).toBe(0);
    expect(summary.linked).toBe(0);
  });

  /**
   * SC-150. The user said this withdrawal left their portfolio; a deposit
   * that would have matched perfectly arrives (or was always there). The
   * nightly pass must not quietly link them and un-answer the question.
   *
   * This is the one failure the review surface cannot recover from on its
   * own: the row would leave the queue looking resolved, with a pairing
   * nobody chose, and the person who answered would never be told.
   */
  test('never re-links a withdrawal a human has already answered', async () => {
    const f = fixture!;
    const at = recentTransferTimestamp();
    await db.insert(schema.holdingTransactions).values([
      {
        userId: f.userId,
        holdingId: f.withdrawHoldingId,
        tokenId: f.tokenId,
        kind: 'withdraw',
        quantity: '-1.0',
        occurredAt: at,
        source: 'kraken-api',
        externalId: 'k-w-6',
        transferReview: 'left_control',
        transferReviewedAt: at,
      },
      {
        userId: f.userId,
        holdingId: f.depositHoldingId,
        tokenId: f.tokenId,
        kind: 'deposit',
        quantity: '1.0',
        occurredAt: new Date(at.getTime() + 5 * 60 * 1000),
        source: 'etherscan',
        externalId: 'e-d-6',
      },
    ]);

    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: f.userId });
    expect(summary.scanned).toBe(0);
    expect(summary.linked).toBe(0);

    const rows = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    expect(rows.every((r) => r.transferGroupId === null)).toBe(true);
  });
  /**
   * Both legs on ONE holding is not a transfer (SC-350).
   *
   * Nothing moved between accounts: a departure and an arrival happened close
   * together in the same wallet, and token + time — the only two facts this
   ***REMOVED***
   ***REMOVED***
   ***REMOVED***
   ***REMOVED***
   * because `claimInflow` will not take a claimed inflow.
   */
  test('does NOT pair an inflow and outflow that sit on the same holding', async () => {
    const f = fixture!;
    const at = recentTransferTimestamp();
    await db.insert(schema.holdingTransactions).values([
      {
        userId: f.userId,
        holdingId: f.withdrawHoldingId,
        tokenId: f.tokenId,
        kind: 'transfer_in',
        quantity: '1000',
        occurredAt: at,
        source: 'etherscan',
        externalId: 'same-in',
      },
      {
        userId: f.userId,
        holdingId: f.withdrawHoldingId,
        tokenId: f.tokenId,
        kind: 'transfer_out',
        quantity: '-1000',
        occurredAt: new Date(at.getTime() + 3 * 60 * 1000),
        source: 'etherscan',
        externalId: 'same-out',
      },
    ]);

    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: f.userId });
    expect(summary.scanned).toBe(1);
    expect(summary.linked).toBe(0);
    // Not `ambiguous` either — the candidate is excluded before the count, so
    // the job summary does not report a judgement it never made.
    expect(summary.ambiguous).toBe(0);

    const rows = await db
      .select({ groupId: schema.holdingTransactions.transferGroupId })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    expect(rows.every((r) => r.groupId === null)).toBe(true);
  });

  test('still pairs across two holdings when the amounts and times match', async () => {
    const f = fixture!;
    // The guard above must not be a blanket refusal of same-token pairs: this is
    // the case the matcher exists for and it has to keep working.
    const at = recentTransferTimestamp();
    await db.insert(schema.holdingTransactions).values([
      {
        userId: f.userId,
        holdingId: f.withdrawHoldingId,
        tokenId: f.tokenId,
        kind: 'transfer_out',
        quantity: '-1000',
        occurredAt: at,
        source: 'etherscan',
        externalId: 'cross-out',
      },
      {
        userId: f.userId,
        holdingId: f.depositHoldingId,
        tokenId: f.tokenId,
        kind: 'transfer_in',
        quantity: '1000',
        occurredAt: new Date(at.getTime() + 3 * 60 * 1000),
        source: 'etherscan',
        externalId: 'cross-in',
      },
    ]);

    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: f.userId });
    expect(summary.linked).toBe(1);
  });
});

/**
 * SC-336 — a bridge's two legs are two token rows on two chains, so the
 * same-token pass cannot see them. Every test here builds the real shape:
 * one wallet, two chain accounts, two token rows for one asset.
 */
describe('LinkTransferPairsUseCase — bridged assets', () => {
  interface Bridge {
    userId: string;
    walletId: string;
    outHoldingId: string;
    inHoldingId: string;
    outTokenId: string;
    inTokenId: string;
    cleanup: () => Promise<void>;
  }

  let bridge: Bridge | null = null;

  async function setupBridge(opts: {
    /** The canonical key on each token row, in order (out, in). */
    keys: [string | null, string | null];
    /** `userWalletId` on each account, in order (out, in). */
    wallets?: [string | null, string | null];
    /** `chainId` on each account, in order (out, in). */
    chains?: [string | null, string | null];
  }): Promise<Bridge> {
    const [user] = await db
      .insert(schema.users)
      .values({ email: `bridge-${randomUUID().slice(0, 8)}@scani.local`, name: 'BridgeTest' })
      .returning();
    if (!user) throw new Error('user insert failed');
    const [instType] = await db
      .insert(schema.institutionTypes)
      .values({ code: `bt-${randomUUID().slice(0, 6)}`, name: 'BridgeTest Type' })
      .returning();
    if (!instType) throw new Error('instType insert failed');
    const [inst] = await db
      .insert(schema.institutions)
      .values({ name: `BT-${randomUUID().slice(0, 6)}`, typeId: instType.id })
      .returning();
    if (!inst) throw new Error('inst insert failed');
    const [acctType] = await db
      .insert(schema.accountTypes)
      .values({ code: `bt-acct-${randomUUID().slice(0, 6)}`, name: 'BridgeTest Account' })
      .returning();
    if (!acctType) throw new Error('acctType insert failed');
    const [tokenType] = await db
      .insert(schema.tokenTypes)
      .values({ code: `bt-tok-${randomUUID().slice(0, 6)}`, name: 'BridgeTest Token Type' })
      .returning();
    if (!tokenType) throw new Error('tokenType insert failed');

    const walletId = randomUUID();
    const wallets = opts.wallets ?? [walletId, walletId];
    const chains = opts.chains ?? ['1', '8453'];

    const accounts = await Promise.all(
      chains.map(async (chainId, i) => {
        const [account] = await db
          .insert(schema.accounts)
          .values({
            userId: user.id,
            institutionId: inst.id,
            typeId: acctType.id,
            name: `bridge-${i}-${randomUUID().slice(0, 6)}`,
            metadata: {
              ...(chainId === null ? {} : { chainId }),
              ...(wallets[i] === null ? {} : { userWalletId: wallets[i] }),
            },
          })
          .returning();
        if (!account) throw new Error('account insert failed');
        return account;
      })
    );

    const tokens = await Promise.all(
      opts.keys.map(async (key) => {
        const [token] = await db
          .insert(schema.tokens)
          .values({
            symbol: `USDC${randomUUID().toUpperCase()}`,
            name: 'BridgeTest USDC',
            typeId: tokenType.id,
            providerMetadata: key === null ? {} : { coingecko: { id: key } },
          })
          .returning();
        if (!token) throw new Error('token insert failed');
        return token;
      })
    );

    const holdings = await Promise.all(
      tokens.map(async (token, i) => {
        const account = accounts[i];
        if (!account) throw new Error('account missing');
        const [holding] = await db
          .insert(schema.holdings)
          .values({
            userId: user.id,
            accountId: account.id,
            tokenId: token.id,
            balance: '0',
          })
          .returning();
        if (!holding) throw new Error('holding insert failed');
        return holding;
      })
    );

    const outHolding = holdings[0];
    const inHolding = holdings[1];
    const outToken = tokens[0];
    const inToken = tokens[1];
    if (!outHolding || !inHolding || !outToken || !inToken) throw new Error('fixture incomplete');

    return {
      userId: user.id,
      walletId,
      outHoldingId: outHolding.id,
      inHoldingId: inHolding.id,
      outTokenId: outToken.id,
      inTokenId: inToken.id,
      cleanup: async () => {
        await db.delete(schema.users).where(eq(schema.users.id, user.id));
        for (const token of tokens) {
          await db.delete(schema.tokens).where(eq(schema.tokens.id, token.id));
        }
        await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, tokenType.id));
        await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, acctType.id));
        await db.delete(schema.institutions).where(eq(schema.institutions.id, inst.id));
        await db.delete(schema.institutionTypes).where(eq(schema.institutionTypes.id, instType.id));
      },
    };
  }

  async function insertLegs(
    b: Bridge,
    opts: { outAt: Date; inAt: Date; outQty?: string; inQty?: string }
  ): Promise<void> {
    await db.insert(schema.holdingTransactions).values([
      {
        userId: b.userId,
        holdingId: b.outHoldingId,
        tokenId: b.outTokenId,
        kind: 'transfer_out',
        quantity: opts.outQty ?? '-100',
        occurredAt: opts.outAt,
        source: 'etherscan',
        externalId: `bridge-out-${randomUUID().slice(0, 8)}`,
      },
      {
        userId: b.userId,
        holdingId: b.inHoldingId,
        tokenId: b.inTokenId,
        kind: 'transfer_in',
        quantity: opts.inQty ?? '99.987151',
        occurredAt: opts.inAt,
        source: 'etherscan',
        externalId: `bridge-in-${randomUUID().slice(0, 8)}`,
      },
    ]);
  }

  async function groupIdsFor(userId: string): Promise<Array<string | null>> {
    const rows = await db
      .select({ groupId: schema.holdingTransactions.transferGroupId })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, userId));
    return rows.map((r) => r.groupId);
  }

  afterEach(async () => {
    if (bridge) await bridge.cleanup();
    bridge = null;
  });

  test('links a bridge: one asset, two chains, one wallet', async () => {
    bridge = await setupBridge({ keys: ['usd-coin', 'usd-coin'] });
    const b = bridge;
    const at = recentTransferTimestamp();
    await insertLegs(b, { outAt: at, inAt: new Date(at.getTime() + 6_000) });

    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: b.userId });
    expect(summary.linked).toBe(1);
    expect(summary.ambiguous).toBe(0);

    const groups = await groupIdsFor(b.userId);
    expect(groups).toHaveLength(2);
    expect(new Set(groups).size).toBe(1);
    expect(groups[0]).not.toBeNull();
  });

  test('refuses two assets that only share a symbol — neither carries a canonical id', async () => {
    bridge = await setupBridge({ keys: [null, null] });
    const b = bridge;
    const at = recentTransferTimestamp();
    await insertLegs(b, { outAt: at, inAt: new Date(at.getTime() + 6_000) });

    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: b.userId });
    expect(summary.linked).toBe(0);
    expect(await groupIdsFor(b.userId)).toEqual([null, null]);
  });

  test('refuses a wrapper against its underlying asset', async () => {
    bridge = await setupBridge({ keys: ['weth', 'ethereum'] });
    const b = bridge;
    const at = recentTransferTimestamp();
    await insertLegs(b, { outAt: at, inAt: new Date(at.getTime() + 6_000) });

    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: b.userId });
    expect(summary.linked).toBe(0);
    expect(await groupIdsFor(b.userId)).toEqual([null, null]);
  });

  test('refuses an arrival that landed BEFORE the money left', async () => {
    bridge = await setupBridge({ keys: ['usd-coin', 'usd-coin'] });
    const b = bridge;
    const at = recentTransferTimestamp();
    await insertLegs(b, { outAt: at, inAt: new Date(at.getTime() - 6 * 60 * 1000) });

    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: b.userId });
    expect(summary.linked).toBe(0);
    expect(await groupIdsFor(b.userId)).toEqual([null, null]);
  });

  test('refuses two chains that are not the same wallet', async () => {
    bridge = await setupBridge({
      keys: ['usd-coin', 'usd-coin'],
      wallets: [randomUUID(), randomUUID()],
    });
    const b = bridge;
    const at = recentTransferTimestamp();
    await insertLegs(b, { outAt: at, inAt: new Date(at.getTime() + 6_000) });

    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: b.userId });
    expect(summary.linked).toBe(0);
    expect(await groupIdsFor(b.userId)).toEqual([null, null]);
  });

  test('refuses one wallet on ONE chain — two token rows for one asset is a wrap, not a bridge', async () => {
    bridge = await setupBridge({
      keys: ['usd-coin', 'usd-coin'],
      chains: ['1', '1'],
    });
    const b = bridge;
    const at = recentTransferTimestamp();
    await insertLegs(b, { outAt: at, inAt: new Date(at.getTime() + 6_000) });

    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: b.userId });
    expect(summary.linked).toBe(0);
    expect(await groupIdsFor(b.userId)).toEqual([null, null]);
  });

  test('refuses an exchange leg, which has no chain to bridge from', async () => {
    bridge = await setupBridge({
      keys: ['usd-coin', 'usd-coin'],
      chains: [null, '8453'],
    });
    const b = bridge;
    const at = recentTransferTimestamp();
    await insertLegs(b, { outAt: at, inAt: new Date(at.getTime() + 6_000) });

    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: b.userId });
    expect(summary.linked).toBe(0);
    expect(await groupIdsFor(b.userId)).toEqual([null, null]);
  });

  test('refuses a bridge whose fee exceeds the same ±1% the matcher already allows', async () => {
    bridge = await setupBridge({ keys: ['usd-coin', 'usd-coin'] });
    const b = bridge;
    const at = recentTransferTimestamp();
    await insertLegs(b, {
      outAt: at,
      inAt: new Date(at.getTime() + 6_000),
      inQty: '98.5',
    });

    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: b.userId });
    expect(summary.linked).toBe(0);
    expect(await groupIdsFor(b.userId)).toEqual([null, null]);
  });

  /**
   * The interaction that decides whether this rule can make anything worse.
   * A same-chain arrival on the source holding and a genuine bridge arrival
   * both fit: two candidates, so the matcher takes neither. Production has
   * exactly this row — 200.082083 USDC arrived on mainnet six minutes before
   * the same amount was bridged to Base — and without this the pass would
   * pair the outflow with the arrival that never moved.
   */
  test('declines rather than choose between a same-token arrival and a bridged one', async () => {
    bridge = await setupBridge({ keys: ['usd-coin', 'usd-coin'] });
    const b = bridge;
    const at = recentTransferTimestamp();
    await insertLegs(b, { outAt: at, inAt: new Date(at.getTime() + 6_000) });
    // A second arrival, same token row as the outflow, on a third holding.
    const [otherAccount] = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, b.userId))
      .limit(1);
    if (!otherAccount) throw new Error('account missing');
    const [rival] = await db
      .insert(schema.holdings)
      .values({ userId: b.userId, accountId: otherAccount.id, tokenId: b.outTokenId, balance: '0' })
      .returning();
    if (!rival) throw new Error('rival holding insert failed');
    await db.insert(schema.holdingTransactions).values({
      userId: b.userId,
      holdingId: rival.id,
      tokenId: b.outTokenId,
      kind: 'transfer_in',
      quantity: '100',
      occurredAt: new Date(at.getTime() + 60_000),
      source: 'etherscan',
      externalId: `rival-${randomUUID().slice(0, 8)}`,
    });

    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: b.userId });
    expect(summary.linked).toBe(0);
    expect(summary.ambiguous).toBe(1);
    expect((await groupIdsFor(b.userId)).every((g) => g === null)).toBe(true);
  });
});

/**
 * SC-611. `transfer_review` is outflow-only, so an INFLOW has nowhere to
 * record that a person authored it — and the matcher's inflow candidate query
 * gated on `transfer_group_id IS NULL` **alone**, with no equivalent of the
 * outflow query's `transfer_review IS NULL`. A deposit somebody typed could
 * therefore be claimed as the arrival leg of an unrelated unanswered outflow,
 * and `CostBasisService` would carry lots across a movement that never
 * happened.
 *
 * ## The rule is about AUTHORITY, not about whether two rows could be a pair
 *
 * It lives in this use case's query rather than in `candidatePairClass`, and
 * that is deliberate — the opposite call from SC-347, for a reason SC-347 does
 * not cover. `candidatePairClass` answers *"are these two rows a plausible
 * pair?"*, a fact about the rows, and every caller must agree on it. This asks
 * *"may the nightly job decide this on its own?"*, which is a question about
 * authority and has a different answer for a person than for a cron.
 *
 * So the review queue goes on OFFERING a hand-entered deposit as an arrival —
 * a reader who picks one is telling us something true, and the last test here
 * is what stops somebody enforcing this "consistently" and removing that.
 *
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 *
 * ## THE "STILL CLAIMS AN ORDINARY DEPOSIT" TEST BELOW IS CORROBORATION, NOT
 * THE GUARD
 *
 * Measured, not assumed: widening this predicate to exclude every inflow
 * source fails SIX tests, and FIVE of them are older than this describe block
 * —
 *
 *   - `links a single matching withdraw/deposit pair within window + epsilon`
 *   - `flags ambiguous pairs when more than one viable deposit matches`
 *   - `still pairs across two holdings when the amounts and times match`
 *   - bridged assets: `links a bridge: one asset, two chains, one wallet`
 *   - bridged assets: `declines rather than choose between a same-token
 *     arrival and a bridged one`
 *
 * Those five are what actually stop an over-broad predicate from fixing this
 * hole by turning the matcher off. The test here agrees with them; it does not
 * hold the line on its own.
 *
 * **If you are deleting or reworking those five, this note is addressed to
 * you.** A reader who sees only the describe block below would conclude the
 * axis is still guarded, when it would in fact be down to one test that was
 * never more than corroboration. Keep coverage of "an ordinary imported
 * deposit still links" somewhere, whatever else changes.
 */
describe('LinkTransferPairsUseCase — a row a person authored is not the matcher’s to claim', () => {
  async function outflowAndInflow(
    f: Fixture,
    opts: { inflowSource: string; externalId: string }
  ): Promise<void> {
    const at = recentTransferTimestamp();
    await db.insert(schema.holdingTransactions).values([
      {
        userId: f.userId,
        holdingId: f.withdrawHoldingId,
        tokenId: f.tokenId,
        kind: 'withdraw',
        quantity: '-1.0',
        occurredAt: at,
        source: 'kraken-api',
        externalId: `${opts.externalId}-out`,
      },
      {
        userId: f.userId,
        holdingId: f.depositHoldingId,
        tokenId: f.tokenId,
        kind: 'deposit',
        // Same ~0.5% drift and 5-minute gap the canonical linking test uses,
        // so the ONLY difference between this and a pair that links is the
        // inflow's source.
        quantity: '0.995',
        occurredAt: new Date(at.getTime() + 5 * 60 * 1000),
        source: opts.inflowSource,
        externalId: `${opts.externalId}-in`,
      },
    ]);
  }

  async function groupIds(f: Fixture): Promise<Array<string | null>> {
    const rows = await db
      .select({ groupId: schema.holdingTransactions.transferGroupId })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    return rows.map((r) => r.groupId);
  }

  test('a balance edit the owner made is not claimed', async () => {
    const f = fixture!;
    await outflowAndInflow(f, { inflowSource: 'user-balance-edit', externalId: 's611-a' });

    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: f.userId });
    expect(summary.linked).toBe(0);
    expect(summary.ambiguous).toBe(0);
    expect((await groupIds(f)).every((g) => g === null)).toBe(true);
  });

  test('a transaction the owner typed is not claimed', async () => {
    const f = fixture!;
    await outflowAndInflow(f, { inflowSource: 'user-entered', externalId: 's611-b' });

    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: f.userId });
    expect(summary.linked).toBe(0);
    expect((await groupIds(f)).every((g) => g === null)).toBe(true);
  });

  test('AN ORDINARY IMPORTED DEPOSIT IS STILL CLAIMED — the feature is not broken', async () => {
    const f = fixture!;
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    await outflowAndInflow(f, { inflowSource: 'etherscan', externalId: 's611-c' });

    const summary = await Container.get(LinkTransferPairsUseCase).execute({ userId: f.userId });
    expect(summary.linked).toBe(1);
    const ids = await groupIds(f);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBeNull();
  });

  test('the review queue still OFFERS a hand-entered deposit as an arrival', async () => {
    const f = fixture!;
    await outflowAndInflow(f, { inflowSource: 'user-entered', externalId: 's611-d' });

    // THE SCOPE CONTROL. The rule is about the matcher's authority, not about
    // whether the two rows could be a pair — so a person working the queue
    // must still be offered this arrival, and picking it is them telling us
    // something the matcher could not know. Moving the predicate into
    // `candidatePairClass` "for consistency" would make this go red, which is
    // the whole reason it lives in the use case's own query.
    //
    // `listPending` rather than `reopenPreview`: that one returns [] unless
    // the row is already ANSWERED, so asserting on it here would have passed
    // for a reason having nothing to do with the change.
    const pending = await new TransferReviewService().listPending(f.userId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.candidates.map((c) => c.quantity)).toEqual(['0.995']);
    expect(pending[0]?.candidates[0]?.withinStrictTolerance).toBe(true);
  });
});
