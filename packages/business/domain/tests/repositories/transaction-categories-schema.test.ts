import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { type SQL, sql } from 'drizzle-orm';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';
import { makeHoldingTransaction } from '../../test/helpers/factories-extra';

/**
 * The tree's rules live in the database too (SC-1652): one level of nesting, a
 * name unique per parent, and no reference across users. Raw SQL on purpose,
 * so the constraint is what is tested and not the service in front of it.
 */

/** The SQLSTATE `statement` is refused with, run in a savepoint so the test can go on. */
async function refusedWith(tx: DatabaseTransaction, statement: SQL): Promise<string | undefined> {
  try {
    await tx.transaction(async (savepoint) => {
      await savepoint.execute(statement);
    });
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

async function category(
  tx: DatabaseTransaction,
  userId: string,
  name: string,
  parentId: string | null = null
): Promise<string> {
  const rows = (await tx.execute(sql`
    insert into transaction_categories (user_id, parent_id, name)
    values (${userId}, ${parentId}, ${name}) returning id`)) as unknown as Array<{ id: string }>;
  return rows[0]?.id as string;
}

describe('transaction_categories (SC-1652)', () => {
  test('a grandchild is refused', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await category(tx, user.id, 'Food');
      const groceries = await category(tx, user.id, 'Groceries', food);
      const code = await refusedWith(
        tx,
        sql`insert into transaction_categories (user_id, parent_id, name) values (${user.id}, ${groceries}, ${'Organic'})`
      );
      expect(code).toBe('23514');
    });
  });

  test('a category with children cannot be given a parent', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await category(tx, user.id, 'Food');
      await category(tx, user.id, 'Groceries', food);
      const fees = await category(tx, user.id, 'Fees');
      const code = await refusedWith(
        tx,
        sql`update transaction_categories set parent_id = ${fees} where id = ${food}`
      );
      expect(code).toBe('23514');
    });
  });

  test('a parent cannot belong to another user', async () => {
    await withTestDb(async (tx) => {
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      const theirs = await category(tx, b.id, 'Food');
      const code = await refusedWith(
        tx,
        sql`insert into transaction_categories (user_id, parent_id, name) values (${a.id}, ${theirs}, ${'Groceries'})`
      );
      expect(code).toBe('23503');
    });
  });

  test("a transaction cannot use another user's category", async () => {
    await withTestDb(async (tx) => {
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      const row = await makeHoldingTransaction(tx, { userId: a.id });
      const theirs = await category(tx, b.id, 'Food');
      const code = await refusedWith(
        tx,
        sql`update holding_transactions set category_id = ${theirs}, category_set_by = 'person' where id = ${row.id}`
      );
      expect(code).toBe('23503');
    });
  });

  test('same name under two parents is allowed; same name twice at the top is not', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await category(tx, user.id, 'Food');
      const fees = await category(tx, user.id, 'Fees');
      await category(tx, user.id, 'Other', food);
      await category(tx, user.id, 'Other', fees);
      const code = await refusedWith(
        tx,
        sql`insert into transaction_categories (user_id, name) values (${user.id}, ${'Food'})`
      );
      expect(code).toBe('23505');
    });
  });

  test('case does not make a new name', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await category(tx, user.id, 'Groceries');
      const code = await refusedWith(
        tx,
        sql`insert into transaction_categories (user_id, name) values (${user.id}, ${'groceries'})`
      );
      expect(code).toBe('23505');
    });
  });

  test('another user may use the same name', async () => {
    await withTestDb(async (tx) => {
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      await category(tx, a.id, 'Food');
      expect(await category(tx, b.id, 'Food')).toBeString();
    });
  });

  test('a set_by without a category, or an unknown set_by, is refused', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const row = await makeHoldingTransaction(tx, { userId: user.id });
      const food = await category(tx, user.id, 'Food');
      expect(
        await refusedWith(
          tx,
          sql`update holding_transactions set category_id = ${food}, category_set_by = 'robot' where id = ${row.id}`
        )
      ).toBe('23514');
      expect(
        await refusedWith(
          tx,
          sql`update holding_transactions set category_set_by = 'person' where id = ${row.id}`
        )
      ).toBe('23514');
    });
  });

  test('accepts rule and ai as who set a category (SC-1695)', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const row = await makeHoldingTransaction(tx, { userId: user.id });
      const food = await category(tx, user.id, 'Food');
      for (const setBy of ['rule', 'ai']) {
        expect(
          await refusedWith(
            tx,
            sql`update holding_transactions set category_id = ${food}, category_set_by = ${setBy} where id = ${row.id}`
          )
        ).toBeUndefined();
      }
    });
  });

  test('still rejects an unknown setter (SC-1695)', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const row = await makeHoldingTransaction(tx, { userId: user.id });
      const food = await category(tx, user.id, 'Food');
      expect(
        await refusedWith(
          tx,
          sql`update holding_transactions set category_id = ${food}, category_set_by = 'bot' where id = ${row.id}`
        )
      ).toBe('23514');
    });
  });

  test("a person's clear is recorded with no category, and never beside one (SC-1695)", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const row = await makeHoldingTransaction(tx, { userId: user.id });
      const food = await category(tx, user.id, 'Food');
      expect(
        await refusedWith(
          tx,
          sql`update holding_transactions set category_id = null, category_set_by = 'cleared' where id = ${row.id}`
        )
      ).toBeUndefined();
      const [after] = (await tx.execute(
        sql`select category_set_by from holding_transactions where id = ${row.id}`
      )) as unknown as Array<{ category_set_by: string | null }>;
      expect(after?.category_set_by).toBe('cleared');
      expect(
        await refusedWith(
          tx,
          sql`update holding_transactions set category_id = ${food}, category_set_by = 'cleared' where id = ${row.id}`
        )
      ).toBe('23514');
    });
  });

  test('deleting a category uncategorizes its transactions and lifts its children', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const food = await category(tx, user.id, 'Food');
      const groceries = await category(tx, user.id, 'Groceries', food);
      const row = await makeHoldingTransaction(tx, { userId: user.id });
      await tx.execute(
        sql`update holding_transactions set category_id = ${food}, category_set_by = 'person' where id = ${row.id}`
      );
      await tx.execute(sql`delete from transaction_categories where id = ${food}`);
      const [after] = (await tx.execute(
        sql`select category_id, category_set_by from holding_transactions where id = ${row.id}`
      )) as unknown as Array<{ category_id: string | null; category_set_by: string | null }>;
      expect(after).toEqual({ category_id: null, category_set_by: null });
      const [child] = (await tx.execute(
        sql`select parent_id from transaction_categories where id = ${groceries}`
      )) as unknown as Array<{ parent_id: string | null }>;
      expect(child?.parent_id).toBeNull();
    });
  });
});
