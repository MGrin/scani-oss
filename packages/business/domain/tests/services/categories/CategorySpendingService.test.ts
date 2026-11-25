import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq, sql } from 'drizzle-orm';
import {
  CategorySpendingDataError,
  CategorySpendingNotFoundError,
  CategorySpendingService,
} from '../../../src/services/categories/CategorySpendingService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../../test/helpers/factories-extra';

const month = '2026-01';
const reader = () => new CategorySpendingService();
async function fixture(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const [type] = await tx
    .select()
    .from(schema.accountTypes)
    .where(eq(schema.accountTypes.code, 'checking'));
  const [fiat] = await tx
    .select()
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, 'fiat'));
  if (!type || !fiat) throw new Error('Missing migrated reference data');
  const token = await makeToken(tx, { typeId: fiat.id });
  const account = await makeAccount(tx, {
    userId: user.id,
    institutionId: institution.id,
    typeId: type.id,
  });
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
  });
  const [food] = await tx
    .insert(schema.transactionCategories)
    .values({ userId: user.id, name: 'Food' })
    .returning();
  if (!food) throw new Error('Missing category');
  const [child] = await tx
    .insert(schema.transactionCategories)
    .values({ userId: user.id, parentId: food.id, name: 'Groceries' })
    .returning();
  if (!child) throw new Error('Missing child');
  const row = (overrides: Partial<typeof schema.holdingTransactions.$inferInsert> = {}) =>
    makeHoldingTransaction(tx, {
      userId: user.id,
      holdingId: holding.id,
      tokenId: token.id,
      occurredAt: new Date('2026-01-15T12:00:00Z'),
      quantity: '-1',
      kind: 'withdraw',
      ledgerKind: 'outflow',
      ...overrides,
    });
  return { user, token, account, holding, food, child, row };
}

describe('CategorySpendingService', () => {
  test('partitions direct parents, children and uncategorized gross spending exactly', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      await f.row({ quantity: '-20', categoryId: f.food.id, categorySetBy: 'person' });
      await f.row({ quantity: '-30', categoryId: f.child.id, categorySetBy: 'custom_rule' });
      await f.row({ quantity: '-5.25' });
      await f.row({ quantity: '-2.50', kind: 'fee', ledgerKind: 'fee' });
      await f.row({ quantity: '8', kind: 'deposit', ledgerKind: 'inflow', categoryId: f.food.id });
      await f.row({ quantity: '3' });
      const result = await reader().read(
        f.user.id,
        { month, detail: { tokenId: f.token.id, category: 'all', offset: 0 } },
        tx
      );
      expect(result.currencies).toHaveLength(1);
      expect(result.currencies[0]?.total).toBe('57.75');
      expect(result.currencies[0]?.count).toBe(4);
      expect(result.currencies[0]?.categories.find((c) => c.categoryId === f.food.id)?.total).toBe(
        '50'
      );
      expect(result.detail?.total).toBe('57.75');
      expect(result.detail?.rows).toHaveLength(4);
      const food = await reader().read(
        f.user.id,
        { month, detail: { tokenId: f.token.id, category: f.food.id, offset: 0 } },
        tx
      );
      expect(food.detail?.total).toBe('50');
      expect(food.detail?.rows.map((r) => r.categoryPath).sort()).toEqual([
        'Food',
        'Food › Groceries',
      ]);
    });
  });

  test('excludes metadata-only settlement fees, transfers, splits and unclassified rows', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      await f.row({ quantity: '-2.5', kind: 'fee', ledgerKind: 'fee' });
      await f.row({
        quantity: '-100',
        kind: 'fee',
        ledgerKind: 'fee',
        sourceMetadata: { settles: null },
      });
      await f.row({ quantity: '-100', transferGroupId: crypto.randomUUID() });
      await f.row({ quantity: '-100', kind: 'transfer_out', ledgerKind: 'transfer_out' });
      await f.row({ quantity: '-100', transferReview: 'internal' });
      await f.row({ quantity: '-100', transferReview: 'untracked' });
      await f.row({
        quantity: '-100',
        transferReview: 'split',
        transferReviewSplit: [{ decision: 'fee', quantity: '100' }],
      });
      await f.row({ quantity: '-100', ledgerKind: null });
      const r = await reader().read(f.user.id, { month }, tx);
      expect(r.currencies[0]?.total).toBe('2.5');
      expect(r.excludedSplitCount).toBe(1);
      expect(r.excludedUnclassifiedCount).toBe(1);
    });
  });

  test('includes inactive history and automatic hides but preserves owner and legacy hides', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      await f.row({ quantity: '-12' });
      await tx
        .update(schema.accounts)
        .set({ isActive: false })
        .where(eq(schema.accounts.id, f.account.id));
      await tx
        .update(schema.holdings)
        .set({ isActive: false, isHidden: true, hiddenBy: 'auto' })
        .where(eq(schema.holdings.id, f.holding.id));
      const r = await reader().read(
        f.user.id,
        { month, detail: { tokenId: f.token.id, category: 'all', offset: 0 } },
        tx
      );
      expect(r.currencies[0]?.total).toBe('12');
      expect(r.accounts.find((a) => a.id === f.account.id)?.isActive).toBe(false);
      expect(r.detail?.rows[0]).toMatchObject({ accountInactive: true, holdingInactive: true });
      for (const hiddenBy of ['user', null] as const) {
        await tx
          .update(schema.holdings)
          .set({ hiddenBy })
          .where(eq(schema.holdings.id, f.holding.id));
        expect((await reader().read(f.user.id, { month }, tx)).currencies).toEqual([]);
      }
      await tx
        .update(schema.holdings)
        .set({ isHidden: false })
        .where(eq(schema.holdings.id, f.holding.id));
      await tx
        .update(schema.accounts)
        .set({ isHidden: true })
        .where(eq(schema.accounts.id, f.account.id));
      expect((await reader().read(f.user.id, { month }, tx)).currencies).toEqual([]);
      await expect(
        reader().read(f.user.id, { month, accountId: f.account.id }, tx)
      ).rejects.toBeInstanceOf(CategorySpendingNotFoundError);
    });
  });

  test('enforces owners, primary tokens, account classes and category selection', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      const other = await fixture(tx);
      await f.row({ quantity: '-4' });
      await other.row({ quantity: '-99' });
      await f.row({ quantity: '-99', tokenId: other.token.id });
      await f.row({ quantity: '-99', userId: other.user.id });
      const [liability] = await tx
        .select()
        .from(schema.accountTypes)
        .where(eq(schema.accountTypes.class, 'liability'));
      if (!liability) throw new Error('Missing liability type');
      await expect(
        reader().read(f.user.id, { month, accountId: other.account.id }, tx)
      ).rejects.toBeInstanceOf(CategorySpendingNotFoundError);
      await expect(
        reader().read(
          f.user.id,
          { month, detail: { tokenId: f.token.id, category: other.food.id, offset: 0 } },
          tx
        )
      ).rejects.toBeInstanceOf(CategorySpendingNotFoundError);
      await expect(
        reader().read(
          f.user.id,
          { month, detail: { tokenId: f.token.id, category: f.child.id, offset: 0 } },
          tx
        )
      ).rejects.toBeInstanceOf(CategorySpendingNotFoundError);
      expect((await reader().read(f.user.id, { month }, tx)).currencies[0]?.total).toBe('4');
      await tx
        .update(schema.accounts)
        .set({ typeId: liability.id })
        .where(eq(schema.accounts.id, f.account.id));
      expect((await reader().read(f.user.id, { month }, tx)).currencies).toEqual([]);
    });
  });

  test('keeps exact numeric totals, UTC microseconds and same-symbol tokens separate', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      await f.row({ quantity: '-123456789012345678901234567890.004' });
      await f.row({ quantity: '-0.006', occurredAt: new Date('2026-01-01T00:00:00Z') });
      const edge = await f.row({ quantity: '-0.1' });
      await tx.execute(
        sql`update holding_transactions set occurred_at = '2026-01-31 23:59:59.999999Z' where id = ${edge.id}`
      );
      await f.row({ quantity: '-999', occurredAt: new Date('2026-02-01T00:00:00Z') });
      const twin = await makeToken(tx, {
        typeId: f.token.typeId,
        symbol: f.token.symbol,
        marketSegment: 'other-test',
      });
      const h = await makeHolding(tx, {
        userId: f.user.id,
        accountId: f.account.id,
        tokenId: twin.id,
      });
      await f.row({ quantity: '-2', holdingId: h.id, tokenId: twin.id });
      const r = await reader().read(f.user.id, { month }, tx);
      expect(r.currencies).toHaveLength(2);
      expect(r.currencies.find((c) => c.tokenId === f.token.id)?.total).toBe(
        '123456789012345678901234567890.11'
      );
      expect(r.currencies.find((c) => c.tokenId === twin.id)?.total).toBe('2');
    });
  });

  test('refuses malformed prospective amounts without casting excluded or foreign data', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      await f.row({ quantity: '-4' });
      await f.row({ quantity: 'bad-trade', kind: 'buy', ledgerKind: 'trade_leg' });
      const other = await fixture(tx);
      await other.row({ quantity: 'NaN' });
      expect((await reader().read(f.user.id, { month }, tx)).currencies[0]?.total).toBe('4');
      const bad = await f.row({ quantity: 'NaN' });
      await expect(reader().read(f.user.id, { month }, tx)).rejects.toBeInstanceOf(
        CategorySpendingDataError
      );
      await tx
        .update(schema.holdingTransactions)
        .set({ quantity: '-1e999999999' })
        .where(eq(schema.holdingTransactions.id, bad.id));
      await expect(reader().read(f.user.id, { month }, tx)).rejects.toBeInstanceOf(
        CategorySpendingDataError
      );
    });
  });

  test('keeps all 503 tied-order transactions reachable in bounded pages', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      await tx.insert(schema.holdingTransactions).values(
        Array.from({ length: 503 }, (_, i) => ({
          userId: f.user.id,
          holdingId: f.holding.id,
          tokenId: f.token.id,
          occurredAt: new Date('2026-01-12T00:00:00Z'),
          kind: 'withdraw',
          ledgerKind: 'outflow',
          quantity: '-0.1',
          source: 'test-fixture',
          externalId: String(i),
        }))
      );
      const ids: string[] = [];
      for (let offset: number | null = 0; offset !== null; ) {
        const r = await reader().read(
          f.user.id,
          { month, detail: { tokenId: f.token.id, category: 'all', offset } },
          tx
        );
        expect(r.detail?.total).toBe('50.3');
        expect(r.detail?.count).toBe(503);
        expect(r.detail?.rows.length).toBeLessThanOrEqual(50);
        ids.push(...(r.detail?.rows.map((row) => row.id) ?? []));
        offset = r.detail?.nextOffset ?? null;
      }
      expect(ids).toHaveLength(503);
      expect(new Set(ids).size).toBe(503);
    });
  });
  test('preserves category owner constraints and reflects deletion without duplicating children', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      const other = await fixture(tx);
      await f.row({ quantity: '-7', categoryId: f.child.id });
      await expect(
        tx.transaction(async (savepoint) => {
          await makeHoldingTransaction(savepoint, {
            userId: f.user.id,
            holdingId: f.holding.id,
            tokenId: f.token.id,
            categoryId: other.food.id,
            quantity: '-4',
            ledgerKind: 'outflow',
          });
        })
      ).rejects.toThrow();
      await tx
        .delete(schema.transactionCategories)
        .where(eq(schema.transactionCategories.id, f.child.id));
      const r = await reader().read(
        f.user.id,
        { month, detail: { tokenId: f.token.id, category: 'uncategorized', offset: 0 } },
        tx
      );
      expect(r.currencies[0]?.total).toBe('7');
      expect(r.detail?.rows[0]?.categoryPath).toBeNull();
      expect(r.detail?.total).toBe('7');
    });
  });

  test('applies a single current-month cutoff and excludes future rows', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      const now = new Date();
      await f.row({ quantity: '-3', occurredAt: new Date(now.getTime() - 1000) });
      await f.row({ quantity: '-100', occurredAt: new Date(now.getTime() + 60_000) });
      const r = await reader().read(f.user.id, { month: now.toISOString().slice(0, 7) }, tx);
      expect(r.currencies[0]?.total).toBe('3');
      expect(r.effectiveTo).toBe(r.generatedAt);
    });
  });
  test('retains the selected category name when its live detail becomes empty', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      await f.row({ quantity: '-4' });
      const report = await reader().read(
        f.user.id,
        { month, detail: { tokenId: f.token.id, category: f.food.id, offset: 0 } },
        tx
      );
      expect(report.detail).toMatchObject({ categoryName: 'Food', total: '0', count: 0, rows: [] });
    });
  });
});
