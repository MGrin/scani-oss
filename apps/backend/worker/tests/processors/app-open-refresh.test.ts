/**
 * SC-1671. Working out which accounts to re-fetch on an app open moved out of
 * the api request and into this job: it asks `AppOpenRefreshService` and
 * enqueues one per-account refresh for each account it names.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { AppOpenRefreshService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { type AppOpenRefreshJob, REFRESH_ACCOUNT_BALANCE } from '@scani/jobs';
import { BullMqEnqueueService, type ProcessorContext } from '@scani/queue';
import { Container } from 'typedi';
import { AppOpenRefreshProcessor } from '../../src/processors/app-open-refresh';

restoreContainerAfterAll();

const JOB: AppOpenRefreshJob = { userId: 'user-1', requestId: 'req-1' };
const CTX = { job: { id: 'job-1' } } as unknown as ProcessorContext;

class TestableProcessor extends AppOpenRefreshProcessor {
  run(data: AppOpenRefreshJob) {
    return this.handle(data, CTX);
  }
}

let enqueued: Array<{ name: string; data: unknown }> = [];

function refreshing(accountIds: string[]): TestableProcessor {
  Container.set(AppOpenRefreshService, {
    accountsToRefresh: async () => accountIds,
  } as unknown as AppOpenRefreshService);
  Container.set(BullMqEnqueueService, {
    add: async (descriptor: { name: string }, data: unknown) => {
      enqueued.push({ name: descriptor.name, data });
      return 'job';
    },
  } as unknown as BullMqEnqueueService);
  return new TestableProcessor();
}

beforeEach(() => {
  enqueued = [];
});

describe('AppOpenRefreshProcessor', () => {
  test('enqueues one refresh-account-balance job per account to refresh', async () => {
    const result = await refreshing(['acc-1', 'acc-2']).run(JOB);
    expect(enqueued).toEqual([
      {
        name: REFRESH_ACCOUNT_BALANCE.name,
        data: { userId: 'user-1', requestId: 'req-1', accountId: 'acc-1' },
      },
      {
        name: REFRESH_ACCOUNT_BALANCE.name,
        data: { userId: 'user-1', requestId: 'req-1', accountId: 'acc-2' },
      },
    ]);
    expect(result).toEqual({ accountsQueued: 2 });
  });

  test('control: no account to refresh enqueues nothing', async () => {
    const result = await refreshing([]).run(JOB);
    expect(enqueued).toEqual([]);
    expect(result).toEqual({ accountsQueued: 0 });
  });
});
