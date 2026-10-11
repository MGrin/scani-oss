/** SC-1652. The ledger filters by category, and a person sets one on many rows at once. */
import { afterEach, describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import {
  HoldingTransactionRepository,
  TransactionsNotFoundError,
} from '@scani/domain/repositories';
import { LearnedCategoryRules } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

function fakeUser(id: string): typeof schema.users.$inferSelect {
  return {
    id,
    email: `${id}@scani.local`,
    name: 'Ledger Test',
    baseCurrencyId: null,
    image: null,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as typeof schema.users.$inferSelect;
}

afterEach(() => Container.remove(HoldingTransactionRepository));

describe('transactions and categories (SC-1652)', () => {
  test('list passes the category filter through, scoped to the caller', async () => {
    const seen: Record<string, unknown>[] = [];
    Container.set(HoldingTransactionRepository, {
      findByRange: async (opts: Record<string, unknown>) => {
        seen.push(opts);
        return [];
      },
    } as unknown as HoldingTransactionRepository);
    const userId = crypto.randomUUID();
    const categoryId = crypto.randomUUID();
    const caller = makeAuthedCaller(fakeUser(userId));
    await caller.transactions.list({ category: { id: categoryId } });
    await caller.transactions.list({ category: 'uncategorized' });
    await caller.transactions.list({ search: 'fresh' });
    expect(seen[0]).toMatchObject({ userId, category: { id: categoryId } });
    expect(seen[1]).toMatchObject({ userId, category: 'uncategorized' });
    expect(seen[2]).toMatchObject({ userId, search: 'fresh' });
  });

  test('pages by cursor, and says where the next page starts only when this one was full', async () => {
    const seen: Record<string, unknown>[] = [];
    Container.set(HoldingTransactionRepository, {
      findByRange: async (opts: Record<string, unknown>) => {
        seen.push(opts);
        return Array.from({ length: opts.limit === 2 ? 2 : 1 }, (_, i) => ({ id: `r${i}` }));
      },
    } as unknown as HoldingTransactionRepository);
    const caller = makeAuthedCaller(fakeUser(crypto.randomUUID()));
    const full = await caller.transactions.list({ limit: 2, cursor: 4 });
    expect(seen[0]).toMatchObject({ limit: 2, offset: 4 });
    expect(full.nextCursor).toBe(6);
    const short = await caller.transactions.list({ limit: 3 });
    expect(short.nextCursor).toBeNull();
  });

  test('setCategory writes for the caller, then spreads the pick to the same payees (SC-1695)', async () => {
    const seen: unknown[][] = [];
    const spread: unknown[][] = [];
    Container.set(HoldingTransactionRepository, {
      setCategory: async (...args: unknown[]) => {
        seen.push(args);
        return { updated: 2 };
      },
    } as unknown as HoldingTransactionRepository);
    Container.set(LearnedCategoryRules, {
      spreadFrom: async (...args: unknown[]) => {
        spread.push(args);
        return 3;
      },
    } as unknown as LearnedCategoryRules);
    const userId = crypto.randomUUID();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const categoryId = crypto.randomUUID();
    const result = await makeAuthedCaller(fakeUser(userId)).transactions.setCategory({
      ids,
      categoryId,
    });
    expect(result).toEqual({ updated: 2, spread: 3 });
    expect(seen[0]?.slice(0, 3)).toEqual([userId, ids, categoryId]);
    expect(spread[0]?.[0]).toBe(userId);
    expect(spread[0]?.slice(2)).toEqual([ids, categoryId]);
    // One transaction for both writes: the pick and its spread land together.
    expect(spread[0]?.[1]).toBe(seen[0]?.[3]);
  });

  test('setCategory refuses 501 rows', async () => {
    const ids = Array.from({ length: 501 }, () => crypto.randomUUID());
    const caller = makeAuthedCaller(fakeUser(crypto.randomUUID()));
    await expect(caller.transactions.setCategory({ ids, categoryId: null })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  test("another user's row is NOT_FOUND", async () => {
    Container.set(HoldingTransactionRepository, {
      setCategory: async () => {
        throw new TransactionsNotFoundError('transactions');
      },
    } as unknown as HoldingTransactionRepository);
    const caller = makeAuthedCaller(fakeUser(crypto.randomUUID()));
    await expect(
      caller.transactions.setCategory({ ids: [crypto.randomUUID()], categoryId: null })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('automatic categories (SC-1695)', () => {
  test("list passes 'auto' through, scoped to the caller", async () => {
    const seen: Record<string, unknown>[] = [];
    Container.set(HoldingTransactionRepository, {
      findByRange: async (opts: Record<string, unknown>) => {
        seen.push(opts);
        return [];
      },
    } as unknown as HoldingTransactionRepository);
    const userId = crypto.randomUUID();
    await makeAuthedCaller(fakeUser(userId)).transactions.list({ category: 'auto' });
    expect(seen[0]).toMatchObject({ userId, category: 'auto' });
  });

  test('confirmCategory keeps the rows for the caller and reports the count', async () => {
    const seen: unknown[][] = [];
    Container.set(HoldingTransactionRepository, {
      confirmCategories: async (...args: unknown[]) => {
        seen.push(args);
        return { confirmed: 2 };
      },
    } as unknown as HoldingTransactionRepository);
    const userId = crypto.randomUUID();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const result = await makeAuthedCaller(fakeUser(userId)).transactions.confirmCategory({ ids });
    expect(result).toEqual({ confirmed: 2 });
    expect(seen[0]?.slice(0, 2)).toEqual([userId, ids]);
  });

  test("confirming another user's row is NOT_FOUND", async () => {
    Container.set(HoldingTransactionRepository, {
      confirmCategories: async () => {
        throw new TransactionsNotFoundError('transactions');
      },
    } as unknown as HoldingTransactionRepository);
    const caller = makeAuthedCaller(fakeUser(crypto.randomUUID()));
    await expect(
      caller.transactions.confirmCategory({ ids: [crypto.randomUUID()] })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
