import type { DatabaseTransaction } from '@scani/db';
import { withTransaction } from '@scani/db/transaction';
import { SUGGESTED_CATEGORIES } from '@scani/shared';
import { Container, Service } from 'typedi';
import { TransactionCategoryRepository } from '../../repositories/TransactionCategoryRepository';
import { normalizeCategoryName } from './category-names';

export class CategoryConflictError extends Error {
  constructor(name: string) {
    super(`A category named "${name}" already exists here.`);
    this.name = 'CategoryConflictError';
  }
}

export class CategoryDepthError extends Error {
  constructor() {
    super('Categories nest one level deep: a subcategory cannot have its own.');
    this.name = 'CategoryDepthError';
  }
}

export class CategoryNotFoundError extends Error {
  constructor() {
    super('Category not found.');
    this.name = 'CategoryNotFoundError';
  }
}

export type CategoryNode = {
  id: string;
  name: string;
  color: string | null;
  parentId: string | null;
  transactionCount: number;
  children: CategoryNode[];
};

/** A person's category tree, one level deep (SC-1652). */
@Service()
export class TransactionCategoryService {
  private readonly repo = Container.get(TransactionCategoryRepository);

  async list(userId: string, tx?: DatabaseTransaction): Promise<CategoryNode[]> {
    const rows = await this.repo.listWithCounts(userId, tx);
    const nodes = new Map<string, CategoryNode>(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          name: r.name,
          color: r.color,
          parentId: r.parentId,
          transactionCount: r.transactionCount,
          children: [],
        },
      ])
    );
    const roots: CategoryNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  async create(
    userId: string,
    input: { name: string; parentId?: string | null; color?: string | null },
    tx?: DatabaseTransaction
  ): Promise<{ id: string }> {
    return await this.run(tx, async (db) => {
      const name = normalizeCategoryName(input.name);
      const parentId = input.parentId ?? null;
      if (parentId) await this.assertCanParent(userId, parentId, db);
      if (await this.repo.findByName(userId, parentId, name, db)) {
        throw new CategoryConflictError(name);
      }
      const id = await this.repo.insertOne(
        { userId, parentId, name, color: input.color ?? null },
        db
      );
      return { id };
    });
  }

  async update(
    userId: string,
    id: string,
    patch: { name?: string; color?: string | null; parentId?: string | null },
    tx?: DatabaseTransaction
  ): Promise<void> {
    await this.run(tx, async (db) => {
      const current = await this.repo.findOwned(userId, id, db);
      if (!current) throw new CategoryNotFoundError();
      const parentId = patch.parentId === undefined ? current.parentId : patch.parentId;
      const name = patch.name === undefined ? current.name : normalizeCategoryName(patch.name);
      if (parentId) {
        if (parentId === id) throw new CategoryDepthError();
        await this.assertCanParent(userId, parentId, db);
        if (await this.repo.hasChildren(userId, id, db)) throw new CategoryDepthError();
      }
      const clash = await this.repo.findByName(userId, parentId, name, db);
      if (clash && clash.id !== id) throw new CategoryConflictError(name);
      await this.repo.updateOwned(
        userId,
        id,
        {
          name,
          parentId,
          ...(patch.color === undefined ? {} : { color: patch.color }),
        },
        db
      );
    });
  }

  /** Its rows go to `replacementId` or become uncategorized; its children move to the top level. */
  async remove(
    userId: string,
    id: string,
    replacementId?: string,
    tx?: DatabaseTransaction
  ): Promise<{ moved: number }> {
    return await this.run(tx, async (db) => {
      const current = await this.repo.findOwned(userId, id, db);
      if (!current) throw new CategoryNotFoundError();
      if (replacementId) {
        const replacement = await this.repo.findOwned(userId, replacementId, db);
        if (!replacement || replacement.id === id || replacement.parentId === id) {
          throw new CategoryNotFoundError();
        }
      }
      const moved = await this.repo.moveTransactions(userId, id, replacementId ?? null, db);
      await this.repo.deleteOwned(userId, id, db);
      return { moved };
    });
  }

  /** The starter set, only for a person with no categories, so a second tap creates nothing. */
  async suggest(
    userId: string,
    names: (key: string) => string,
    tx?: DatabaseTransaction
  ): Promise<{ created: number }> {
    return await this.run(tx, async (db) => {
      if ((await this.repo.countForUser(userId, db)) > 0) return { created: 0 };
      let created = 0;
      for (const [order, entry] of SUGGESTED_CATEGORIES.entries()) {
        const parentId = await this.repo.insertOne(
          {
            userId,
            name: normalizeCategoryName(names(entry.key)),
            displayOrder: order,
          },
          db
        );
        created++;
        for (const child of entry.children) {
          await this.repo.insertOne(
            {
              userId,
              parentId,
              name: normalizeCategoryName(names(child)),
            },
            db
          );
          created++;
        }
      }
      return { created };
    });
  }

  /** The leaf for `parent › child`, creating either level that is missing. Matches ignore case. */
  async findOrCreatePath(
    userId: string,
    parent: string,
    child: string | null,
    tx?: DatabaseTransaction
  ): Promise<string> {
    return await this.run(tx, async (db) => {
      const parentName = normalizeCategoryName(parent);
      const parentId =
        (await this.repo.findByName(userId, null, parentName, db))?.id ??
        (await this.repo.insertOne({ userId, name: parentName }, db));
      if (!child) return parentId;
      const childName = normalizeCategoryName(child);
      return (
        (await this.repo.findByName(userId, parentId, childName, db))?.id ??
        (await this.repo.insertOne({ userId, parentId, name: childName }, db))
      );
    });
  }

  private async assertCanParent(
    userId: string,
    parentId: string,
    db: DatabaseTransaction
  ): Promise<void> {
    const parent = await this.repo.findOwned(userId, parentId, db);
    if (!parent) throw new CategoryNotFoundError();
    if (parent.parentId) throw new CategoryDepthError();
  }

  private async run<T>(
    tx: DatabaseTransaction | undefined,
    fn: (db: DatabaseTransaction) => Promise<T>
  ): Promise<T> {
    return tx ? await fn(tx) : await withTransaction(fn, { name: 'transaction-categories' });
  }
}
