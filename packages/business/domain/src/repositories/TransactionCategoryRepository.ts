import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewTransactionCategory, TransactionCategory } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Service } from 'typedi';

const t = schema.transactionCategories;

@Service()
export class TransactionCategoryRepository extends BaseRepository<
  TransactionCategory,
  NewTransactionCategory
> {
  protected readonly table = t;
  protected readonly tableName = 'transaction_categories';

  async listWithCounts(
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<Array<TransactionCategory & { transactionCount: number }>> {
    // Qualified by hand: drizzle renders a column bare inside `sql`, and a bare
    // `id` here would bind to the subquery's own row.
    const counts = sql<number>`(select count(*)::int from holding_transactions h
      where h.user_id = transaction_categories.user_id and h.category_id = transaction_categories.id)`;
    return await this.getDb(tx)
      .select({
        id: t.id,
        userId: t.userId,
        parentId: t.parentId,
        name: t.name,
        color: t.color,
        displayOrder: t.displayOrder,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        transactionCount: counts,
      })
      .from(t)
      .where(eq(t.userId, userId))
      .orderBy(t.displayOrder, sql`lower(${t.name})`);
  }

  async findOwned(
    userId: string,
    id: string,
    tx?: DatabaseTransaction
  ): Promise<TransactionCategory | undefined> {
    const [row] = await this.getDb(tx)
      .select()
      .from(t)
      .where(and(eq(t.userId, userId), eq(t.id, id)));
    return row;
  }

  async findByName(
    userId: string,
    parentId: string | null,
    name: string,
    tx?: DatabaseTransaction
  ): Promise<TransactionCategory | undefined> {
    const [row] = await this.getDb(tx)
      .select()
      .from(t)
      .where(
        and(
          eq(t.userId, userId),
          parentId ? eq(t.parentId, parentId) : isNull(t.parentId),
          sql`lower(${t.name}) = lower(${name})`
        )
      );
    return row;
  }

  async hasChildren(userId: string, id: string, tx?: DatabaseTransaction): Promise<boolean> {
    const [row] = await this.getDb(tx)
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.userId, userId), eq(t.parentId, id)))
      .limit(1);
    return Boolean(row);
  }

  async countForUser(userId: string, tx?: DatabaseTransaction): Promise<number> {
    const [row] = await this.getDb(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(t)
      .where(eq(t.userId, userId));
    return row?.n ?? 0;
  }

  async insertOne(row: NewTransactionCategory, tx?: DatabaseTransaction): Promise<string> {
    const [created] = await this.getDb(tx).insert(t).values(row).returning({ id: t.id });
    return created?.id as string;
  }

  async updateOwned(
    userId: string,
    id: string,
    patch: Partial<Pick<NewTransactionCategory, 'name' | 'color' | 'parentId'>>,
    tx?: DatabaseTransaction
  ): Promise<void> {
    await this.getDb(tx)
      .update(t)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(t.userId, userId), eq(t.id, id)));
  }

  /** Moves a category's rows to `to`, or uncategorizes them; returns how many moved. */
  async moveTransactions(
    userId: string,
    from: string,
    to: string | null,
    tx?: DatabaseTransaction
  ): Promise<number> {
    const h = schema.holdingTransactions;
    const moved = await this.getDb(tx)
      .update(h)
      // A move keeps who set each row, so a guess stays a guess (SC-1695).
      .set(to ? { categoryId: to } : { categoryId: null, categorySetBy: null })
      .where(and(eq(h.userId, userId), eq(h.categoryId, from)))
      .returning({ id: h.id });
    return moved.length;
  }

  async deleteOwned(userId: string, id: string, tx?: DatabaseTransaction): Promise<void> {
    await this.getDb(tx)
      .delete(t)
      .where(and(eq(t.userId, userId), eq(t.id, id)));
  }
}
