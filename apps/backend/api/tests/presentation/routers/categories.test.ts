/** SC-1652. The categories router maps each domain refusal to a tRPC code. */
import { afterEach, describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import {
  CategoryConflictError,
  CategoryDepthError,
  CategoryNotFoundError,
  TransactionCategoryService,
} from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { SUGGESTED_CATEGORY_KEYS } from '@scani/shared';
import { Container } from 'typedi';
import { makeAuthedCaller, makeUnauthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

function fakeUser(id: string): typeof schema.users.$inferSelect {
  return {
    id,
    email: `${id}@scani.local`,
    name: 'Category Test',
    baseCurrencyId: null,
    image: null,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as typeof schema.users.$inferSelect;
}

function stub(methods: Partial<Record<keyof TransactionCategoryService, unknown>>) {
  Container.set(TransactionCategoryService, methods as unknown as TransactionCategoryService);
}

const allNames = Object.fromEntries(SUGGESTED_CATEGORY_KEYS.map((key) => [key, `name ${key}`]));

afterEach(() => Container.remove(TransactionCategoryService));

describe('categories router (SC-1652)', () => {
  test('a duplicate name is CONFLICT', async () => {
    stub({
      create: async () => {
        throw new CategoryConflictError('Food');
      },
    });
    const caller = makeAuthedCaller(fakeUser(crypto.randomUUID()));
    await expect(caller.categories.create({ name: 'Food' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  test('a third level is BAD_REQUEST, and a missing category NOT_FOUND', async () => {
    stub({
      create: async () => {
        throw new CategoryDepthError();
      },
      update: async () => {
        throw new CategoryNotFoundError();
      },
    });
    const caller = makeAuthedCaller(fakeUser(crypto.randomUUID()));
    await expect(
      caller.categories.create({ name: 'Deep', parentId: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.categories.update({ id: crypto.randomUUID(), name: 'X' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test("passes the caller's own user, and suggest uses the names it was given", async () => {
    const seen: unknown[][] = [];
    stub({
      list: async (...args: unknown[]) => {
        seen.push(args);
        return [];
      },
      suggest: async (userId: string, names: (key: string) => string) => {
        seen.push([userId, names('food'), names('groceries')]);
        return { created: 13 };
      },
    });
    const userId = crypto.randomUUID();
    const caller = makeAuthedCaller(fakeUser(userId));
    expect(await caller.categories.list()).toEqual([]);
    expect(await caller.categories.suggest({ names: allNames })).toEqual({ created: 13 });
    expect(seen[0]?.[0]).toBe(userId);
    expect(seen[1]).toEqual([userId, 'name food', 'name groceries']);
  });

  test('suggest refuses a set of names with one missing', async () => {
    stub({ suggest: async () => ({ created: 0 }) });
    const { food: _dropped, ...partial } = allNames;
    const caller = makeAuthedCaller(fakeUser(crypto.randomUUID()));
    await expect(caller.categories.suggest({ names: partial })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  test('every procedure needs a session', async () => {
    const caller = makeUnauthedCaller();
    const id = crypto.randomUUID();
    for (const call of [
      () => caller.categories.list(),
      () => caller.categories.create({ name: 'Food' }),
      () => caller.categories.update({ id, name: 'Food' }),
      () => caller.categories.delete({ id }),
      () => caller.categories.suggest({ names: allNames }),
      () => caller.transactions.setCategory({ ids: [id], categoryId: null }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });
});
