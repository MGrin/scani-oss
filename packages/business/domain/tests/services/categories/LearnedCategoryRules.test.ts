import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { LearnedCategoryRules } from '../../../src/services/categories/LearnedCategoryRules';
import { TransactionCategoryService } from '../../../src/services/categories/TransactionCategoryService';
import { withTestDb } from '../../../test/helpers/db';
import { makeUser } from '../../../test/helpers/factories';
import { makeHoldingTransaction } from '../../../test/helpers/factories-extra';

const rules = () => Container.get(LearnedCategoryRules);
const categories = () => Container.get(TransactionCategoryService);

type SetBy = 'person' | 'import' | 'rule' | 'cleared' | null;

/** A small ledger for one user: every row on one holding, seeded as given. */
async function ledger(tx: DatabaseTransaction, userId: string) {
  let holdingId: string | undefined;
  return async (
    counterparty: string | null,
    categoryId: string | null = null,
    setBy: SetBy = null,
    description: string | null = null
  ) => {
    const row = await makeHoldingTransaction(tx, { userId, holdingId, counterparty, description });
    holdingId = row.holdingId;
    if (categoryId) {
      await tx.execute(
        sql`update holding_transactions set category_id = ${categoryId}, category_set_by = ${setBy} where id = ${row.id}`
      );
    }
    return row.id;
  };
}

async function stateOf(
  tx: DatabaseTransaction,
  id: string
): Promise<[string | null, string | null]> {
  const [row] = (await tx.execute(
    sql`select category_id, category_set_by from holding_transactions where id = ${id}`
  )) as unknown as Array<{ category_id: string | null; category_set_by: string | null }>;
  return [row?.category_id ?? null, row?.category_set_by ?? null];
}

async function category(tx: DatabaseTransaction, userId: string, name: string): Promise<string> {
  return (await categories().create(userId, { name }, tx)).id;
}

describe('LearnedCategoryRules.afterImport (SC-1695)', () => {
  test('runs the whole-user spread for that user', async () => {
    const seen: string[] = [];
    const rules = new LearnedCategoryRules();
    rules.apply = async (userId) => {
      seen.push(userId);
      return { categorized: 0 };
    };
    await rules.afterImport('user-1');
    expect(seen).toEqual(['user-1']);
  });

  test('a failure is logged and never fails the import', async () => {
    const rules = new LearnedCategoryRules();
    rules.apply = async () => {
      throw new Error('boom');
    };
    await expect(rules.afterImport('user-1')).resolves.toBeUndefined();
  });
});

describe('LearnedCategoryRules (SC-1695)', () => {
  test("a person's pick spreads to the same payee's uncategorized rows", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await category(tx, user.id, 'Food');
      const row = await ledger(tx, user.id);
      await row('Tesco Stores Ltd', food, 'person');
      const a = await row('TESCO STORES');
      const b = await row('Tesco Stores Limited');

      expect(await rules().apply(user.id, tx)).toEqual({ categorized: 2 });
      expect(await stateOf(tx, a)).toEqual([food, 'rule']);
      expect(await stateOf(tx, b)).toEqual([food, 'rule']);
    });
  });

  test('never writes over a person or an import', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await category(tx, user.id, 'Food');
      const shop = await category(tx, user.id, 'Shopping');
      const row = await ledger(tx, user.id);
      for (let i = 0; i < 4; i += 1) await row('Tesco', food, 'person');
      const picked = await row('Tesco', shop, 'person');
      const imported = await row('Tesco', shop, 'import');

      await rules().apply(user.id, tx);
      expect(await stateOf(tx, picked)).toEqual([shop, 'person']);
      expect(await stateOf(tx, imported)).toEqual([shop, 'import']);
    });
  });

  test("a correction that flips the majority moves that payee's rule rows", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await category(tx, user.id, 'Food');
      const shop = await category(tx, user.id, 'Shopping');
      const row = await ledger(tx, user.id);
      const guessed = await row('Tesco', food, 'rule');
      await row('Tesco', shop, 'person');
      await row('Tesco', shop, 'person');
      await row('Tesco', food, 'person');

      await rules().apply(user.id, tx);
      expect(await stateOf(tx, guessed)).toEqual([shop, 'rule']);
    });
  });

  test('a split under two thirds teaches nothing', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await category(tx, user.id, 'Food');
      const shop = await category(tx, user.id, 'Shopping');
      const row = await ledger(tx, user.id);
      await row('Tesco', food, 'person');
      await row('Tesco', shop, 'person');
      const open = await row('Tesco');

      expect(await rules().apply(user.id, tx)).toEqual({ categorized: 0 });
      expect(await stateOf(tx, open)).toEqual([null, null]);
    });
  });

  test('a row with no payee key spreads nothing and does not throw', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await category(tx, user.id, 'Food');
      const row = await ledger(tx, user.id);
      await row(null, food, 'person', 'ab');
      await row(null, null, null, 'ab');

      expect(await rules().apply(user.id, tx)).toEqual({ categorized: 0 });
    });
  });

  test("another user's rows are never read or written", async () => {
    await withTestDb(async (tx) => {
      const alice = await makeUser(tx);
      const bob = await makeUser(tx);
      const food = await category(tx, alice.id, 'Food');
      await (await ledger(tx, alice.id))('Tesco', food, 'person');
      const bobs = await (await ledger(tx, bob.id))('Tesco');

      await rules().apply(alice.id, tx);
      expect(await stateOf(tx, bobs)).toEqual([null, null]);
    });
  });

  test("clearing a rule's only evidence leaves its rule rows as they are", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await category(tx, user.id, 'Food');
      const row = await ledger(tx, user.id);
      const pick = await row('Tesco', food, 'person');
      const spread = await row('Tesco');
      await rules().apply(user.id, tx);
      await tx.execute(sql`update holding_transactions set category_id = null where id = ${pick}`);

      await rules().apply(user.id, tx);
      expect(await stateOf(tx, spread)).toEqual([food, 'rule']);
    });
  });

  test('plan says what apply would do and writes nothing', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await category(tx, user.id, 'Food');
      const row = await ledger(tx, user.id);
      await row('Tesco', food, 'person');
      const open = await row('Tesco');

      const planned = await rules().plan(user.id, tx);
      expect(planned).toEqual([{ transactionId: open, categoryId: food, key: 'tesco' }]);
      expect(await stateOf(tx, open)).toEqual([null, null]);
    });
  });

  test('fromIds limits the run to the payees of those rows', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await category(tx, user.id, 'Food');
      const fun = await category(tx, user.id, 'Fun');
      const row = await ledger(tx, user.id);
      const pick = await row('Tesco', food, 'person');
      const tesco = await row('Tesco');
      await row('Netflix', fun, 'person');
      const netflix = await row('Netflix');

      expect(await rules().apply(user.id, tx, { fromIds: [pick] })).toEqual({ categorized: 1 });
      expect(await stateOf(tx, tesco)).toEqual([food, 'rule']);
      expect(await stateOf(tx, netflix)).toEqual([null, null]);
    });
  });

  test('a row the person cleared stays cleared, after a pick and after a whole-user run', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await category(tx, user.id, 'Food');
      const row = await ledger(tx, user.id);
      const pick = await row('Tesco', food, 'person');
      await row('Tesco', food, 'person');
      const cleared = await row('Tesco');
      await tx.execute(
        sql`update holding_transactions set category_set_by = 'cleared' where id = ${cleared}`
      );

      await rules().apply(user.id, tx, { fromIds: [pick] });
      await rules().apply(user.id, tx);
      expect(await stateOf(tx, cleared)).toEqual([null, 'cleared']);
    });
  });

  test('spreadFrom counts only the rows that took the picked category', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await category(tx, user.id, 'Food');
      const shop = await category(tx, user.id, 'Shopping');
      const row = await ledger(tx, user.id);
      for (let i = 0; i < 3; i += 1) await row('Tesco', shop, 'import');
      const pick = await row('Tesco', food, 'person');
      const open = await row('Tesco');
      const netflix = await row('Netflix', food, 'person');
      const netflixOpen = await row('Netflix');

      expect(await rules().spreadFrom(user.id, tx, [pick], food)).toBe(0);
      expect(await stateOf(tx, open)).toEqual([shop, 'rule']);
      expect(await rules().spreadFrom(user.id, tx, [netflix], food)).toBe(1);
      expect(await stateOf(tx, netflixOpen)).toEqual([food, 'rule']);
    });
  });
});
