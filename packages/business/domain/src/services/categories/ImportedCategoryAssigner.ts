import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { TransactionCategoryRepository } from '../../repositories/TransactionCategoryRepository';
import { parseImportedCategory } from './category-names';
import { TransactionCategoryService } from './TransactionCategoryService';

export type ImportedCategoryRow = { id: string; category: string | null };

/**
 * Puts imported rows into the category their source app gave them, creating
 * each category once. A category a person chose is never overwritten (SC-1652).
 */
@Service()
export class ImportedCategoryAssigner {
  private readonly categories = Container.get(TransactionCategoryService);
  private readonly repo = Container.get(TransactionCategoryRepository);

  async assign(
    userId: string,
    rows: readonly ImportedCategoryRow[],
    tx: DatabaseTransaction
  ): Promise<{ categorized: number; created: number }> {
    const byPath = new Map<string, { parent: string; child: string | null; ids: string[] }>();
    for (const row of rows) {
      const path = parseImportedCategory(row.category);
      if (!path) continue;
      const key = `${path.parent.toLowerCase()}\u0000${path.child?.toLowerCase() ?? ''}`;
      const group = byPath.get(key) ?? { ...path, ids: [] };
      group.ids.push(row.id);
      byPath.set(key, group);
    }
    if (byPath.size === 0) return { categorized: 0, created: 0 };

    const before = await this.repo.countForUser(userId, tx);
    const t = schema.holdingTransactions;
    let categorized = 0;
    for (const { parent, child, ids } of byPath.values()) {
      const categoryId = await this.categories.findOrCreatePath(userId, parent, child, tx);
      const updated = await tx
        .update(t)
        .set({ categoryId, categorySetBy: 'import', updatedAt: sql`now()` })
        .where(
          and(
            eq(t.userId, userId),
            inArray(t.id, ids),
            // Never over a person's pick or a person's clear (SC-1695).
            sql`coalesce(${t.categorySetBy}, '') not in ('person', 'cleared')`
          )
        )
        .returning({ id: t.id });
      categorized += updated.length;
    }
    return { categorized, created: (await this.repo.countForUser(userId, tx)) - before };
  }
}
