import { beforeEach, describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { AppOpenRefreshService, UserService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { APP_OPEN_REFRESH } from '@scani/jobs';
import { BullMqEnqueueService } from '@scani/queue';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

/**
 * SC-1671. The PWA calls `users.appOpened` on every return to the tab, and
 * working out which accounts to refresh inside the request held the api's
 * event loop for 19.4 s on production. The request now only stamps the visit
 * and hands the rest to the worker as one job.
 */

restoreContainerAfterAll();

const USER = '00000000-0000-4000-8000-000000000071';
const REQUEST = '00000000-0000-4000-8000-0000000000a1';
const dbUser = { id: USER, email: 'open@test.local' } as typeof schema.users.$inferSelect;

let enqueued: Array<{ name: string; data: unknown }> = [];
let seen: string[] = [];
let refreshAsked = 0;

beforeEach(() => {
  enqueued = [];
  seen = [];
  refreshAsked = 0;
  Container.set(BullMqEnqueueService, {
    add: async (descriptor: { name: string }, data: unknown) => {
      enqueued.push({ name: descriptor.name, data });
      return 'job';
    },
  } as unknown as BullMqEnqueueService);
  Container.set(UserService, {
    markAppSeen: async (userId: string) => {
      seen.push(userId);
    },
  } as unknown as UserService);
  Container.set(AppOpenRefreshService, {
    accountsToRefresh: async () => {
      refreshAsked++;
      return ['acc-1', 'acc-2', 'acc-3'];
    },
  } as unknown as AppOpenRefreshService);
});

describe('users.appOpened', () => {
  test('stamps the visit and enqueues exactly one app-open-refresh job', async () => {
    await makeAuthedCaller(dbUser).users.appOpened({ requestId: REQUEST });
    expect(seen).toEqual([USER]);
    expect(enqueued).toEqual([
      { name: APP_OPEN_REFRESH.name, data: { userId: USER, requestId: REQUEST } },
    ]);
  });

  test('never works out the accounts inside the request', async () => {
    await makeAuthedCaller(dbUser).users.appOpened({ requestId: REQUEST });
    expect(refreshAsked).toBe(0);
  });
});
