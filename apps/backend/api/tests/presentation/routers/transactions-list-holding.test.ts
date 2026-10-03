/**
 * SC-1527. The holding peek lists ONE holding's movements, so `transactions.list`
 * has to take the holding rather than its (account, token): two pots of the same
 * currency in one account share both, and the peek of one would list the
 * other's movements as its own. The repository already filters on `holdingId`;
 * this pins that the router passes it through, still scoped to the caller.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { HoldingTransactionRepository } from '@scani/domain/repositories';
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

describe('transactions.list by holding', () => {
  test("filters on the holding and the caller's own user", async () => {
    const seen: Record<string, unknown>[] = [];
    Container.set(HoldingTransactionRepository, {
      findByRange: async (opts: Record<string, unknown>) => {
        seen.push(opts);
        return [];
      },
    } as unknown as HoldingTransactionRepository);

    const userId = crypto.randomUUID();
    const holdingId = crypto.randomUUID();
    const result = await makeAuthedCaller(fakeUser(userId)).transactions.list({
      holdingId,
      limit: 10,
    });

    expect(result).toEqual({ transactions: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ userId, holdingId, limit: 10, order: 'desc' });
  });

  test('refuses a holding id that is not a uuid', async () => {
    const caller = makeAuthedCaller(fakeUser(crypto.randomUUID()));
    await expect(caller.transactions.list({ holdingId: 'not-a-uuid' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
