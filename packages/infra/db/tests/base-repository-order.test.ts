import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { BaseRepository, type DatabaseTransaction } from '../src/base-repository';
import { getDb } from '../src/connection';

/**
 * SC-1635: BaseRepository's list reads return rows in id order. Two red mains
 * in one day asserted an order on a read with no ORDER BY, and a PR build ran
 * the same test green by chance, because Postgres returns whatever order the
 * plan produces.
 *
 * The rows go in as c, a, b. The CONTROL reads them with no ORDER BY and must
 * see that insertion order: without it, a plan that happened to return a, b, c
 * would make the ordered assertions pass over the very bug they guard.
 */

const probe = pgTable('zz_base_repository_order_probe', {
  id: text('id').primaryKey(),
  n: integer('n').notNull(),
});

class ProbeRepository extends BaseRepository<typeof probe.$inferSelect> {
  protected readonly table = probe;
  protected readonly tableName = 'zz_base_repository_order_probe';
}

class Rollback extends Error {}

async function withProbe(fn: (tx: DatabaseTransaction) => Promise<void>): Promise<void> {
  try {
    await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`CREATE TEMP TABLE zz_base_repository_order_probe (id text PRIMARY KEY, n integer NOT NULL) ON COMMIT DROP`
      );
      for (const [id, n] of [
        ['c', 3],
        ['a', 1],
        ['b', 2],
      ] as const)
        await tx.insert(probe).values({ id, n });
      await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe('BaseRepository list reads are in id order (SC-1635)', () => {
  const repo = new ProbeRepository();

  test('CONTROL: with no ORDER BY the rows come back in insertion order', async () => {
    await withProbe(async (tx) => {
      expect(ids(await tx.select().from(probe))).toEqual(['c', 'a', 'b']);
    });
  });

  test('findByIds', async () => {
    await withProbe(async (tx) => {
      expect(ids(await repo.findByIds(['b', 'c', 'a'], tx))).toEqual(['a', 'b', 'c']);
    });
  });

  test('findAll', async () => {
    await withProbe(async (tx) => {
      expect(ids(await repo.findAll(undefined, tx))).toEqual(['a', 'b', 'c']);
    });
  });

  test('findWithPagination: each page is the same rows on every read', async () => {
    await withProbe(async (tx) => {
      expect(ids((await repo.findWithPagination(1, 2, undefined, tx)).data)).toEqual(['a', 'b']);
      expect(ids((await repo.findWithPagination(2, 2, undefined, tx)).data)).toEqual(['c']);
    });
  });
});
