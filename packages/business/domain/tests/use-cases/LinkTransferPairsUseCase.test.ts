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
      symbol: `LT${randomUUID().slice(0, 4).toUpperCase()}`,
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
});
