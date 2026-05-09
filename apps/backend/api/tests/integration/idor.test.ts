/**
 * Integration-level IDOR sanity tests.
 *
 * Routers run their ownership guard against rows the user doesn't own
 * by stubbing the repositories via typedi's container. The goal isn't
 * to exercise Drizzle queries (the repository tests do that) but to
 * verify the router actually checks the userId on the row before
 * acting on it. A regression here would silently expose other users'
 * data through the tRPC surface.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { HoldingApyConfigRepository, HoldingRepository } from '@scani/domain/repositories';
import { Container } from 'typedi';
import { makeAuthedCaller, makeUnauthedCaller } from '../helpers/test-caller';

// Capture the @Service()-registered originals BEFORE any test mutates
// the container. Each test restores them in afterEach so a stub from
// one test never leaks into a later domain test that resolves the same
// repository from the shared container — `Container.reset()` would
// wipe the @Service() registration entirely (CLAUDE.md), so explicit
// re-set is the safe pattern.
let realHoldingRepository: HoldingRepository;
let realHoldingApyConfigRepository: HoldingApyConfigRepository;

beforeAll(() => {
  realHoldingRepository = Container.get(HoldingRepository);
  realHoldingApyConfigRepository = Container.get(HoldingApyConfigRepository);
});

afterEach(() => {
  Container.set(HoldingRepository, realHoldingRepository);
  Container.set(HoldingApyConfigRepository, realHoldingApyConfigRepository);
});

function fakeUser(id: string): typeof schema.users.$inferSelect {
  return {
    id,
    email: `${id}@scani.local`,
    name: 'Test User',
    baseCurrencyId: null,
    image: null,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as typeof schema.users.$inferSelect;
}

function fakeHolding(opts: { id: string; userId: string }): typeof schema.holdings.$inferSelect {
  return {
    id: opts.id,
    userId: opts.userId,
    accountId: 'account-1',
    tokenId: 'token-1',
    balance: '100',
    source: 'manual',
    isActive: true,
    isHidden: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as typeof schema.holdings.$inferSelect;
}

describe('IDOR — holdings router', () => {
  test("getApyConfig refuses to read another user's holding", async () => {
    const ownerId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const attackerId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const holdingId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

    let findCalls = 0;
    let apyConfigQueried = false;
    Container.set(HoldingRepository, {
      findByIdVisible: async (_id: string) => {
        findCalls += 1;
        return fakeHolding({ id: holdingId, userId: ownerId });
      },
    } as unknown as HoldingRepository);
    // Sentinel — if the router ever reaches the apy-config lookup the
    // ownership check has already failed open. We don't want a fake
    // empty answer; we want a hard error.
    Container.set(HoldingApyConfigRepository, {
      findByHoldingId: async () => {
        apyConfigQueried = true;
        throw new Error('apy-config lookup must not run on cross-user IDOR');
      },
    } as unknown as HoldingApyConfigRepository);

    const caller = makeAuthedCaller(fakeUser(attackerId));
    await expect(caller.holdings.getApyConfig({ holdingId })).rejects.toThrow(/Holding not found/);
    expect(findCalls).toBeGreaterThanOrEqual(1);
    expect(apyConfigQueried).toBe(false);
  });

  test("refreshBalance refuses to act on another user's holding", async () => {
    const ownerId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const attackerId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const holdingId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

    Container.set(HoldingRepository, {
      findById: async (_id: string) => fakeHolding({ id: holdingId, userId: ownerId }),
    } as unknown as HoldingRepository);

    const caller = makeAuthedCaller(fakeUser(attackerId));
    await expect(
      caller.holdings.refreshBalance({
        holdingId,
        requestId: '11111111-1111-1111-1111-111111111111',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('Auth — holdings router', () => {
  test('getApyConfig rejects unauthenticated callers', async () => {
    const caller = makeUnauthedCaller();
    await expect(
      caller.holdings.getApyConfig({ holdingId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
