import { beforeEach, describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { AIRouter, UserService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

/** SC-1695. AI category suggestions are off until the person turns them on. */

restoreContainerAfterAll();

const USER = '00000000-0000-4000-8000-000000001695';
const user = (aiCategoriesAt: Date | null) =>
  ({ id: USER, email: 'ai@test.local', aiCategoriesAt }) as typeof schema.users.$inferSelect;

let writes: Array<[string, boolean]> = [];
let completion = true;

beforeEach(() => {
  writes = [];
  completion = true;
  Container.set(UserService, {
    setAiCategories: async (userId: string, enabled: boolean) => {
      writes.push([userId, enabled]);
    },
  } as unknown as UserService);
  Container.set(AIRouter, {
    getAvailability: async () => ({ completion }),
  } as unknown as AIRouter);
});

describe('users.getAiCategories / setAiCategories', () => {
  test('off for a person who never turned it on, and says whether the instance can', async () => {
    expect(await makeAuthedCaller(user(null)).users.getAiCategories()).toEqual({
      enabled: false,
      available: true,
    });
    completion = false;
    expect(await makeAuthedCaller(user(new Date())).users.getAiCategories()).toEqual({
      enabled: true,
      available: false,
    });
  });

  test("turning it on and off writes the caller's own setting", async () => {
    const caller = makeAuthedCaller(user(null));
    expect(await caller.users.setAiCategories({ enabled: true })).toEqual({ enabled: true });
    expect(await caller.users.setAiCategories({ enabled: false })).toEqual({ enabled: false });
    expect(writes).toEqual([
      [USER, true],
      [USER, false],
    ]);
  });
});
