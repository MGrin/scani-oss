import { beforeEach, describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import {
  type IncludedDailyTotalsRow,
  PortfolioValueDailyRepository,
} from '@scani/domain/repositories';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { _resetNetWorthCache } from '../../../src/lib/net-worth-cache';
import { makeAuthedCaller } from '../../helpers/test-caller';

/**
 * SC-1775. The hero keeps a line for its coverage note while the rollup has
 * not written this user's history yet, and only then: a window that is merely
 * outside the history there is (the visual suite pins its clock in 2027) has
 * no note coming, and a kept line there is a permanent blank.
 */
restoreContainerAfterAll();

const USER = {
  id: '00000000-0000-4000-8000-0000000017f5',
  email: 'pending@scani.local',
  baseCurrencyId: '00000000-0000-4000-8000-0000000000b5',
} as typeof schema.users.$inferSelect;

const WINDOW = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-28T00:00:00Z') };

function measured(snapshotDate: string): IncludedDailyTotalsRow {
  return {
    snapshotDate,
    totalValue: '1000',
    costBasis: null,
    realizedPnl: null,
    unrealizedPnl: null,
    holdingsWithKnownValue: 1,
    holdingsTotal: 1,
    holdingsUnpriceable: 0,
    holdingsStalePriced: 0,
    holdingsStaleAnchored: 0,
    oldestAnchorAt: null,
    holdingsBeforeRecords: 0,
    holdingsBasisUnknown: 0,
    transfersUnreviewed: 0,
    anyPartial: false,
  };
}

let latestLookups = 0;

function stubRollup(window: IncludedDailyTotalsRow[], latestSnapshot: string | null) {
  latestLookups = 0;
  Container.set(PortfolioValueDailyRepository, {
    findIncludedHoldingDailyTotals: async () => window,
    findLatestSnapshotDate: async () => {
      latestLookups += 1;
      return latestSnapshot;
    },
  } as unknown as PortfolioValueDailyRepository);
}

beforeEach(() => _resetNetWorthCache());

describe('portfolio.getNetWorthSeries historyPending (SC-1775)', () => {
  test('an account the rollup has never written is pending', async () => {
    stubRollup([], null);
    const out = await makeAuthedCaller(USER).portfolio.getNetWorthSeries(WINDOW);
    expect(out.historyPending).toBe(true);
  });

  test('a window outside the history there is is not pending', async () => {
    stubRollup([], '2026-09-14');
    const out = await makeAuthedCaller(USER).portfolio.getNetWorthSeries(WINDOW);
    expect(out.historyPending).toBe(false);
  });

  test('control: a window with a measured day is not pending and asks nothing more', async () => {
    stubRollup([measured('2026-10-27')], null);
    const out = await makeAuthedCaller(USER).portfolio.getNetWorthSeries(WINDOW);
    expect(out.historyPending).toBe(false);
    expect(latestLookups).toBe(0);
  });
});
