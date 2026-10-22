import { describe, expect, test } from 'bun:test';
import {
  createRealtimeInvalidator,
  invalidateForUserEvent,
  resyncAfterReconnect,
} from '../../src/hooks/invalidatePortfolioQueries';

/**
 * Two gaps the SC-1598 liveness audit found in the realtime client (SC-1599):
 * a base-currency change made in another tab left the hero and the returns in
 * the old currency there, and a reopened socket refetched nothing, so every
 * event sent while it was down stayed lost until a navigation.
 */

type Utils = Parameters<typeof resyncAfterReconnect>[0];

function recordingUtils(): { utils: Utils; calls: string[] } {
  const calls: string[] = [];
  const router = (name: string) => ({
    invalidate: async (_input?: unknown, opts?: { refetchType?: string }) => {
      calls.push(`${name}:${opts?.refetchType ?? 'active'}`);
    },
  });
  const names = [
    'accounts',
    'holdings',
    'institutions',
    'dashboard',
    'vaults',
    'groups',
    'portfolio',
    'transactions',
    'liabilities',
    'jobs',
    'review',
  ];
  const utils = {
    ...Object.fromEntries(names.map((n) => [n, router(n)])),
    users: {
      ...router('users'),
      getCurrent: router('users.getCurrent'),
      getBaseCurrency: router('users.getBaseCurrency'),
    },
  } as unknown as Utils;
  return { utils, calls };
}

/** One event through the realtime invalidator, flushed at once (SC-1754 coalesces). */
async function afterEntity(utils: Utils, entityType: string): Promise<void> {
  const inv = createRealtimeInvalidator(() => utils);
  inv.entity(entityType);
  await inv.flush();
}

async function afterJob(utils: Utils, state: string): Promise<void> {
  const inv = createRealtimeInvalidator(() => utils);
  inv.job({ state });
  await inv.flush();
}

describe('a user event from another tab (SC-1599)', () => {
  test('a base-currency change refetches the portfolio series the hero and returns read', async () => {
    const { utils, calls } = recordingUtils();
    await invalidateForUserEvent(utils, { source: 'base-currency-change' });
    expect(calls).toContain('portfolio:all');
    expect(calls).toContain('dashboard:all');
  });

  test('control: any other user event refreshes the user queries and nothing else', async () => {
    const { utils, calls } = recordingUtils();
    await invalidateForUserEvent(utils, { source: 'cost-basis-method-change' });
    expect(calls.sort()).toEqual(['users.getBaseCurrency:active', 'users.getCurrent:active']);
  });
});

describe('a reopened socket (SC-1599)', () => {
  test('refetches what a missed event would have refreshed, on screen only', async () => {
    const { utils, calls } = recordingUtils();
    await resyncAfterReconnect(utils);
    for (const name of ['dashboard', 'holdings', 'accounts', 'portfolio', 'jobs', 'review']) {
      expect(calls).toContain(`${name}:active`);
    }
    expect(calls.filter((c) => c.endsWith(':all'))).toEqual([]);
  });
});

describe('an entity event (SC-1600)', () => {
  test('a portfolio event refetches the chart series on screen', async () => {
    const { utils, calls } = recordingUtils();
    await afterEntity(utils, 'portfolio');
    expect(calls).toEqual(['portfolio:active']);
  });

  test('control: a holding event refetches the portfolio set and not the chart', async () => {
    const { utils, calls } = recordingUtils();
    await afterEntity(utils, 'holding');
    expect(calls).toContain('holdings:active');
    expect(calls).not.toContain('portfolio:active');
  });

  test('control: an unknown entity type refetches nothing', async () => {
    const { utils, calls } = recordingUtils();
    await afterEntity(utils, 'schedule');
    expect(calls).toEqual([]);
  });
});

// A finished job (an import, a sync) can add review items, and only the Jobs
// page's listener refreshed them, so NeedsYou on Home missed them (SC-1715).
describe('a job event (SC-1715)', () => {
  test('a finished job refetches the review list on screen', async () => {
    for (const state of ['completed', 'failed'] as const) {
      const { utils, calls } = recordingUtils();
      await afterJob(utils, state);
      expect(calls).toEqual(['review:active']);
    }
  });

  test('control: a job still running refetches nothing', async () => {
    for (const state of ['queued', 'active', 'progress'] as const) {
      const { utils, calls } = recordingUtils();
      await afterJob(utils, state);
      expect(calls).toEqual([]);
    }
  });
});
