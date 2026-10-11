import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { AccountRepository } from '../../../src/repositories/AccountRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { BalanceRefreshabilityService } from '../../../src/services/holdings/BalanceRefreshabilityService';
import { AppOpenRefreshService } from '../../../src/services/users/AppOpenRefreshService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

const NOW = new Date('2026-10-07T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function service(
  holdings: Array<{ id: string; accountId: string; answer: string }>,
  lastSync: Record<string, string | undefined>
): AppOpenRefreshService {
  Container.set(HoldingRepository, {
    findByUser: async () => holdings.map(({ id, accountId }) => ({ id, accountId })),
  } as unknown as HoldingRepository);
  Container.set(BalanceRefreshabilityService, {
    forHoldings: async () => new Map(holdings.map((h) => [h.id, h.answer])),
  } as unknown as BalanceRefreshabilityService);
  Container.set(AccountRepository, {
    findByIds: async (ids: string[]) =>
      ids.map((id) => ({ id, metadata: lastSync[id] ? { lastSync: lastSync[id] } : {} })),
  } as unknown as AccountRepository);
  return new AppOpenRefreshService();
}

describe('AppOpenRefreshService (SC-1602)', () => {
  test('refreshes each refreshable account once, unless it synced in the last ten minutes', async () => {
    const svc = service(
      [
        { id: 'h1', accountId: 'stale', answer: 'refreshable' },
        { id: 'h2', accountId: 'stale', answer: 'refreshable' },
        { id: 'h3', accountId: 'never', answer: 'refreshable' },
        { id: 'h4', accountId: 'recent', answer: 'refreshable' },
        { id: 'h5', accountId: 'edge', answer: 'refreshable' },
        { id: 'h6', accountId: 'manual', answer: 'not-a-feed' },
      ],
      { stale: minutesAgo(45), recent: minutesAgo(3), edge: minutesAgo(10) }
    );

    expect((await svc.accountsToRefresh('u', NOW)).sort()).toEqual(['edge', 'never', 'stale']);
  });

  test('a user with nothing refreshable asks for nothing', async () => {
    const svc = service([{ id: 'h1', accountId: 'a', answer: 'no-live-sync' }], {});
    expect(await svc.accountsToRefresh('u', NOW)).toEqual([]);
  });
});
