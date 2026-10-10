import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { sql } from 'drizzle-orm';
import { Container } from 'typedi';
import {
  HoldingTransactionRepository,
  TransactionsNotFoundError,
} from '../../src/repositories/HoldingTransactionRepository';
import { TransactionCategoryService } from '../../src/services/categories/TransactionCategoryService';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';
import { makeHoldingTransaction } from '../../test/helpers/factories-extra';

const repo = () => Container.get(HoldingTransactionRepository);
const categories = () => Container.get(TransactionCategoryService);

async function categoryOf(tx: DatabaseTransaction, id: string) {
  const [row] = (await tx.execute(
    sql`select category_id, category_set_by from holding_transactions where id = ${id}`
  )) as unknown as Array<{ category_id: string | null; category_set_by: string | null }>;
  return row;
}

async function tree(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const food = (await categories().create(user.id, { name: 'Food' }, tx)).id;
  const groceries = (await categories().create(user.id, { name: 'Groceries', parentId: food }, tx))
    .id;
  const fees = (await categories().create(user.id, { name: 'Fees' }, tx)).id;
  return { user, food, groceries, fees };
}

describe('HoldingTransactionRepository categories (SC-1652)', () => {
  test("a parent's filter returns its own rows and its children's", async () => {
    await withTestDb(async (tx) => {
      const { user, food, groceries, fees } = await tree(tx);
      const a = await makeHoldingTransaction(tx, { userId: user.id });
      const b = await makeHoldingTransaction(tx, { userId: user.id });
      const c = await makeHoldingTransaction(tx, { userId: user.id });
      await repo().setCategory(user.id, [a.id], food, tx);
      await repo().setCategory(user.id, [b.id], groceries, tx);
      await repo().setCategory(user.id, [c.id], fees, tx);
      const rows = await repo().findByRange({ userId: user.id, category: { id: food } }, tx);
      expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
      expect(rows.every((r) => r.categoryId === food || r.categoryId === groceries)).toBe(true);
    });
  });

  test("'uncategorized' returns only rows with no category", async () => {
    await withTestDb(async (tx) => {
      const { user, fees } = await tree(tx);
      const kept = await makeHoldingTransaction(tx, { userId: user.id });
      const done = await makeHoldingTransaction(tx, { userId: user.id });
      await repo().setCategory(user.id, [done.id], fees, tx);
      const rows = await repo().findByRange({ userId: user.id, category: 'uncategorized' }, tx);
      expect(rows.map((r) => r.id)).toEqual([kept.id]);
    });
  });

  test("a filter on another user's category returns nothing", async () => {
    await withTestDb(async (tx) => {
      const mine = await tree(tx);
      const theirs = await tree(tx);
      const row = await makeHoldingTransaction(tx, { userId: theirs.user.id });
      await repo().setCategory(theirs.user.id, [row.id], theirs.food, tx);
      const rows = await repo().findByRange(
        { userId: mine.user.id, category: { id: theirs.food } },
        tx
      );
      expect(rows).toEqual([]);
    });
  });

  test("setCategory with one id that is not the person's changes nothing", async () => {
    await withTestDb(async (tx) => {
      const { user, food } = await tree(tx);
      const other = await makeUser(tx);
      const a = await makeHoldingTransaction(tx, { userId: user.id });
      const b = await makeHoldingTransaction(tx, { userId: user.id });
      const theirs = await makeHoldingTransaction(tx, { userId: other.id });
      await expect(
        tx.transaction((sp) => repo().setCategory(user.id, [a.id, b.id, theirs.id], food, sp))
      ).rejects.toThrow(TransactionsNotFoundError);
      for (const id of [a.id, b.id, theirs.id]) {
        expect(await categoryOf(tx, id)).toEqual({ category_id: null, category_set_by: null });
      }
    });
  });

  test("setCategory refuses another user's category", async () => {
    await withTestDb(async (tx) => {
      const mine = await tree(tx);
      const theirs = await tree(tx);
      const row = await makeHoldingTransaction(tx, { userId: mine.user.id });
      await expect(
        tx.transaction((sp) => repo().setCategory(mine.user.id, [row.id], theirs.food, sp))
      ).rejects.toThrow(TransactionsNotFoundError);
    });
  });

  test('setCategory sets the person as the setter, and null records that the person cleared it (SC-1695)', async () => {
    await withTestDb(async (tx) => {
      const { user, fees } = await tree(tx);
      const row = await makeHoldingTransaction(tx, { userId: user.id });
      expect(await repo().setCategory(user.id, [row.id], fees, tx)).toEqual({ updated: 1 });
      expect(await categoryOf(tx, row.id)).toEqual({
        category_id: fees,
        category_set_by: 'person',
      });
      await repo().setCategory(user.id, [row.id], null, tx);
      expect(await categoryOf(tx, row.id)).toEqual({
        category_id: null,
        category_set_by: 'cleared',
      });
    });
  });

  test("a re-import leaves a row's category alone", async () => {
    await withTestDb(async (tx) => {
      const { user, fees } = await tree(tx);
      const row = await makeHoldingTransaction(tx, {
        userId: user.id,
        source: 'statement-csv',
        externalId: 'stmt-1',
        description: 'BANK FEE',
      });
      await repo().setCategory(user.id, [row.id], fees, tx);
      await repo().bulkUpsert(
        [
          {
            userId: user.id,
            holdingId: row.holdingId,
            tokenId: row.tokenId,
            kind: row.kind,
            quantity: row.quantity,
            occurredAt: row.occurredAt,
            source: 'statement-csv',
            externalId: 'stmt-1',
            description: 'BANK FEE (corrected)',
          },
        ],
        tx
      );
      expect(await categoryOf(tx, row.id)).toEqual({
        category_id: fees,
        category_set_by: 'person',
      });
    });
  });
});

describe('HoldingTransactionRepository search (SC-1652)', () => {
  test('matches the description or the counterparty, ignoring case, and treats % literally', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const market = await makeHoldingTransaction(tx, {
        userId: user.id,
        description: 'Fresh Market',
      });
      const payee = await makeHoldingTransaction(tx, {
        userId: user.id,
        counterparty: 'FRESH FOODS LTD',
      });
      await makeHoldingTransaction(tx, { userId: user.id, description: 'Bookshop' });
      const percent = await makeHoldingTransaction(tx, {
        userId: user.id,
        description: '10% off',
      });
      const ids = async (search: string) =>
        (await repo().findByRange({ userId: user.id, search }, tx)).map((r) => r.id).sort();
      expect(await ids('fresh')).toEqual([market.id, payee.id].sort());
      expect(await ids('%')).toEqual([percent.id]);
      expect(await ids('  ')).toHaveLength(4);
    });
  });
});

describe('automatic categories (SC-1695)', () => {
  async function setBy(tx: DatabaseTransaction, id: string, categoryId: string, by: string) {
    await tx.execute(
      sql`update holding_transactions set category_id = ${categoryId}, category_set_by = ${by} where id = ${id}`
    );
  }

  test("'auto' returns only rows a rule or AI categorized", async () => {
    await withTestDb(async (tx) => {
      const { user, food } = await tree(tx);
      const [rule, ai, person, imported, none] = await Promise.all(
        [1, 2, 3, 4, 5].map(() => makeHoldingTransaction(tx, { userId: user.id }))
      );
      await setBy(tx, rule!.id, food, 'rule');
      await setBy(tx, ai!.id, food, 'ai');
      await setBy(tx, person!.id, food, 'person');
      await setBy(tx, imported!.id, food, 'import');
      void none;
      const rows = await repo().findByRange({ userId: user.id, category: 'auto' }, tx);
      expect(rows.map((r) => r.id).sort()).toEqual([rule!.id, ai!.id].sort());
    });
  });

  test('confirmCategories makes an automatic category the person’s, keeping it', async () => {
    await withTestDb(async (tx) => {
      const { user, food } = await tree(tx);
      const row = await makeHoldingTransaction(tx, { userId: user.id });
      await setBy(tx, row.id, food, 'rule');
      expect(await repo().confirmCategories(user.id, [row.id], tx)).toEqual({ confirmed: 1 });
      expect(await categoryOf(tx, row.id)).toEqual({
        category_id: food,
        category_set_by: 'person',
      });
    });
  });

  test("confirming a person's own category counts nothing and does not throw", async () => {
    await withTestDb(async (tx) => {
      const { user, food } = await tree(tx);
      const row = await makeHoldingTransaction(tx, { userId: user.id });
      await repo().setCategory(user.id, [row.id], food, tx);
      expect(await repo().confirmCategories(user.id, [row.id], tx)).toEqual({ confirmed: 0 });
      expect(await categoryOf(tx, row.id)).toEqual({
        category_id: food,
        category_set_by: 'person',
      });
    });
  });

  test("confirming another user's row is refused and changes nothing", async () => {
    await withTestDb(async (tx) => {
      const { user: alice, food } = await tree(tx);
      const bob = await makeUser(tx);
      const mine = await makeHoldingTransaction(tx, { userId: alice.id });
      const theirs = await makeHoldingTransaction(tx, { userId: bob.id });
      await setBy(tx, mine.id, food, 'rule');
      await expect(
        repo().confirmCategories(alice.id, [mine.id, theirs.id], tx)
      ).rejects.toBeInstanceOf(TransactionsNotFoundError);
      expect(await categoryOf(tx, mine.id)).toEqual({ category_id: food, category_set_by: 'rule' });
    });
  });
});
