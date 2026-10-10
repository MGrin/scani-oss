import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { sql } from 'drizzle-orm';
import { Container } from 'typedi';
import {
  CategoryConflictError,
  CategoryDepthError,
  CategoryNotFoundError,
  TransactionCategoryService,
} from '../../../src/services/categories/TransactionCategoryService';
import { withTestDb } from '../../../test/helpers/db';
import { makeUser } from '../../../test/helpers/factories';
import { makeHoldingTransaction } from '../../../test/helpers/factories-extra';

const service = () => Container.get(TransactionCategoryService);
const english = (key: string) => `${key[0]!.toUpperCase()}${key.slice(1)}`;

async function categorize(tx: DatabaseTransaction, rowId: string, categoryId: string) {
  await tx.execute(
    sql`update holding_transactions set category_id = ${categoryId}, category_set_by = 'person' where id = ${rowId}`
  );
}

async function categoryOf(tx: DatabaseTransaction, rowId: string) {
  const [row] = (await tx.execute(
    sql`select category_id, category_set_by from holding_transactions where id = ${rowId}`
  )) as unknown as Array<{ category_id: string | null; category_set_by: string | null }>;
  return row;
}

describe('TransactionCategoryService (SC-1652)', () => {
  test('create refuses a duplicate under the same parent, whatever its case or spacing', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await service().create(user.id, { name: 'Groceries' }, tx);
      await expect(service().create(user.id, { name: ' groceries ' }, tx)).rejects.toThrow(
        CategoryConflictError
      );
    });
  });

  test('create refuses a child as a parent', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await service().create(user.id, { name: 'Food' }, tx);
      const groceries = await service().create(
        user.id,
        { name: 'Groceries', parentId: food.id },
        tx
      );
      await expect(
        service().create(user.id, { name: 'Organic', parentId: groceries.id }, tx)
      ).rejects.toThrow(CategoryDepthError);
    });
  });

  test('update refuses to give a parent to a category that has children', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await service().create(user.id, { name: 'Food' }, tx);
      await service().create(user.id, { name: 'Groceries', parentId: food.id }, tx);
      const fees = await service().create(user.id, { name: 'Fees' }, tx);
      await expect(service().update(user.id, food.id, { parentId: fees.id }, tx)).rejects.toThrow(
        CategoryDepthError
      );
    });
  });

  test('list nests children under parents and counts transactions', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await service().create(user.id, { name: 'Food' }, tx);
      const groceries = await service().create(
        user.id,
        { name: 'Groceries', parentId: food.id },
        tx
      );
      const row = await makeHoldingTransaction(tx, { userId: user.id });
      await categorize(tx, row.id, groceries.id);
      const tree = await service().list(user.id, tx);
      expect(tree).toHaveLength(1);
      expect(tree[0]?.name).toBe('Food');
      expect(tree[0]?.transactionCount).toBe(0);
      expect(tree[0]?.children.map((c) => [c.name, c.transactionCount])).toEqual([
        ['Groceries', 1],
      ]);
    });
  });

  test('remove with a replacement moves its transactions there, keeping who set each (SC-1695)', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const a = await service().create(user.id, { name: 'Eating out' }, tx);
      const b = await service().create(user.id, { name: 'Restaurants' }, tx);
      const row = await makeHoldingTransaction(tx, { userId: user.id });
      const guessed = await makeHoldingTransaction(tx, { userId: user.id });
      await categorize(tx, row.id, a.id);
      await tx.execute(
        sql`update holding_transactions set category_id = ${a.id}, category_set_by = 'rule' where id = ${guessed.id}`
      );
      expect(await service().remove(user.id, a.id, b.id, tx)).toEqual({ moved: 2 });
      expect(await categoryOf(tx, row.id)).toEqual({
        category_id: b.id,
        category_set_by: 'person',
      });
      expect(await categoryOf(tx, guessed.id)).toEqual({
        category_id: b.id,
        category_set_by: 'rule',
      });
    });
  });

  test('remove without one uncategorizes its rows and lifts its children with theirs', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await service().create(user.id, { name: 'Food' }, tx);
      const groceries = await service().create(
        user.id,
        { name: 'Groceries', parentId: food.id },
        tx
      );
      const own = await makeHoldingTransaction(tx, { userId: user.id });
      const childs = await makeHoldingTransaction(tx, { userId: user.id });
      await categorize(tx, own.id, food.id);
      await categorize(tx, childs.id, groceries.id);
      await service().remove(user.id, food.id, undefined, tx);
      expect(await categoryOf(tx, own.id)).toEqual({ category_id: null, category_set_by: null });
      expect((await categoryOf(tx, childs.id))?.category_id).toBe(groceries.id);
      const tree = await service().list(user.id, tx);
      expect(tree.map((n) => [n.name, n.parentId])).toEqual([['Groceries', null]]);
    });
  });

  test('remove refuses itself, or one of its children, as the replacement', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await service().create(user.id, { name: 'Food' }, tx);
      await expect(service().remove(user.id, food.id, food.id, tx)).rejects.toThrow(
        CategoryNotFoundError
      );
    });
  });

  test('suggest creates the starter set once, and nothing when categories exist', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      expect(await service().suggest(user.id, english, tx)).toEqual({ created: 18 });
      const names = (await service().list(user.id, tx)).map((n) => n.name);
      expect(names).toContain('Food');
      expect(names).toContain('Fees');
      expect(await service().suggest(user.id, english, tx)).toEqual({ created: 0 });
      const other = await makeUser(tx);
      await service().create(other.id, { name: 'Mine' }, tx);
      expect(await service().suggest(other.id, english, tx)).toEqual({ created: 0 });
    });
  });

  test('findOrCreatePath reuses a name the person already has, ignoring case', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await service().create(user.id, { name: 'Food' }, tx);
      const leaf = await service().findOrCreatePath(user.id, 'food', 'groceries', tx);
      const again = await service().findOrCreatePath(user.id, 'FOOD', 'Groceries', tx);
      expect(again).toBe(leaf);
      const tree = await service().list(user.id, tx);
      expect(tree.map((n) => n.id)).toEqual([food.id]);
      expect(tree[0]?.children.map((c) => c.name)).toEqual(['groceries']);
    });
  });

  test("every method refuses another user's category", async () => {
    await withTestDb(async (tx) => {
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      const theirs = await service().create(b.id, { name: 'Food' }, tx);
      await expect(
        service().create(a.id, { name: 'Groceries', parentId: theirs.id }, tx)
      ).rejects.toThrow(CategoryNotFoundError);
      await expect(service().update(a.id, theirs.id, { name: 'X' }, tx)).rejects.toThrow(
        CategoryNotFoundError
      );
      await expect(service().remove(a.id, theirs.id, undefined, tx)).rejects.toThrow(
        CategoryNotFoundError
      );
      const mine = await service().create(a.id, { name: 'Mine' }, tx);
      await expect(service().remove(a.id, mine.id, theirs.id, tx)).rejects.toThrow(
        CategoryNotFoundError
      );
    });
  });
});
