import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { ImportedCategoryAssigner } from '../../../src/services/categories/ImportedCategoryAssigner';
import { TransactionCategoryService } from '../../../src/services/categories/TransactionCategoryService';
import { withTestDb } from '../../../test/helpers/db';
import { makeUser } from '../../../test/helpers/factories';
import { makeHoldingTransaction } from '../../../test/helpers/factories-extra';

const assigner = () => Container.get(ImportedCategoryAssigner);
const categories = () => Container.get(TransactionCategoryService);

async function pathOf(
  tx: DatabaseTransaction,
  rowId: string
): Promise<[string | null, string | null]> {
  const [row] = (await tx.execute(sql`
    select coalesce(p.name || ' › ' || c.name, c.name) as path, h.category_set_by as by
    from holding_transactions h
    left join transaction_categories c on c.id = h.category_id
    left join transaction_categories p on p.id = c.parent_id
    where h.id = ${rowId}`)) as unknown as Array<{ path: string | null; by: string | null }>;
  return [row?.path ?? null, row?.by ?? null];
}

describe('ImportedCategoryAssigner (SC-1652)', () => {
  test('creates each category once and categorizes every row', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const [a, b, c] = await Promise.all(
        [1, 2, 3].map(() => makeHoldingTransaction(tx, { userId: user.id }))
      );
      const result = await assigner().assign(
        user.id,
        [
          { id: a!.id, category: 'Bills: Rent' },
          { id: b!.id, category: 'Bills: Rent' },
          { id: c!.id, category: 'Groceries' },
        ],
        tx
      );
      expect(result).toEqual({ categorized: 3, created: 3 });
      expect(await pathOf(tx, a!.id)).toEqual(['Bills › Rent', 'import']);
      expect(await pathOf(tx, c!.id)).toEqual(['Groceries', 'import']);
      const again = await assigner().assign(user.id, [{ id: a!.id, category: 'Bills: Rent' }], tx);
      expect(again.created).toBe(0);
    });
  });

  test("a person's category is never overwritten", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const row = await makeHoldingTransaction(tx, { userId: user.id });
      const fees = await categories().create(user.id, { name: 'Fees' }, tx);
      await tx.execute(
        sql`update holding_transactions set category_id = ${fees.id}, category_set_by = 'person' where id = ${row.id}`
      );
      const result = await assigner().assign(
        user.id,
        [{ id: row.id, category: 'Bills: Rent' }],
        tx
      );
      expect(result.categorized).toBe(0);
      expect(await pathOf(tx, row.id)).toEqual(['Fees', 'person']);
    });
  });

  test("YNAB's own bookkeeping and a missing category leave the row uncategorized", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const a = await makeHoldingTransaction(tx, { userId: user.id });
      const b = await makeHoldingTransaction(tx, { userId: user.id });
      const result = await assigner().assign(
        user.id,
        [
          { id: a.id, category: 'Inflow: Ready to Assign' },
          { id: b.id, category: null },
        ],
        tx
      );
      expect(result).toEqual({ categorized: 0, created: 0 });
      expect(await pathOf(tx, a.id)).toEqual([null, null]);
    });
  });

  test("never writes another user's row", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const other = await makeUser(tx);
      const theirs = await makeHoldingTransaction(tx, { userId: other.id });
      const result = await assigner().assign(user.id, [{ id: theirs.id, category: 'Food' }], tx);
      expect(result.categorized).toBe(0);
      expect(await pathOf(tx, theirs.id)).toEqual([null, null]);
    });
  });

  test('an import never overwrites a row the person cleared (SC-1695)', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const row = await makeHoldingTransaction(tx, { userId: user.id });
      await tx.execute(
        sql`update holding_transactions set category_set_by = 'cleared' where id = ${row.id}`
      );
      const result = await assigner().assign(user.id, [{ id: row.id, category: 'Groceries' }], tx);
      expect(result.categorized).toBe(0);
      expect(await pathOf(tx, row.id)).toEqual([null, 'cleared']);
    });
  });
});
