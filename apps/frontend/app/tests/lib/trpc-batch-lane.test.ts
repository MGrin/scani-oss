import { describe, expect, test } from 'bun:test';
import { trpcBatchLane } from '../../src/lib/trpc-batch-lane';

describe('trpcBatchLane', () => {
  test('the returns calls share a lane of their own', () => {
    // Together, not one each: they ask the engine the same question over the
    // same window, and the api's request-scoped cache only dedupes them while
    // they arrive in one request.
    expect(trpcBatchLane('portfolio.getReturns')).toBe('returns');
    expect(trpcBatchLane('portfolio.getReturnsComparison')).toBe('returns');
  });

  test('gains by wrapper rides the returns lane: it runs the same engine (SC-1742)', () => {
    // In the default lane it held Home's household row, bills, groups and
    // vaults for as long as the engine took: 8-17 s on production.
    expect(trpcBatchLane('portfolio.getGainsByWrapper')).toBe('returns');
  });

  test('the fast half of the same router stays in the default lane', () => {
    // The control. A `portfolio.` prefix would have put the hero chart back
    // behind the returns engine, which is the defect this removes.
    expect(trpcBatchLane('portfolio.getNetWorthSeries')).toBe('default');
    expect(trpcBatchLane('portfolio.getPnLSeries')).toBe('default');
    expect(trpcBatchLane('users.getCurrent')).toBe('default');
  });

  test('the one-bit probe rides with the fast calls', () => {
    // It is on Home's critical path on purpose — it is what the Returns tab's
    // withdrawal decision now costs — so it must not sit behind the engine.
    expect(trpcBatchLane('portfolio.hasReturns')).toBe('default');
  });

  test('income rides its own lane, off the hero chart and off the returns engine (SC-1644)', () => {
    // A ledger range read priced at receipt: batched with the hero's series it
    // would hold the chart back, and batched with the returns engine it would
    // wait on the rollup.
    expect(trpcBatchLane('portfolio.getIncome')).toBe('income');
  });

  test("the shell's review feed rides its own lane, off every page's first batch (SC-1671)", () => {
    // The shell asks for it on every page, so in the default lane it joined
    // each page's cold batch: Accounts' four ~100 ms reads waited on it, p50
    // 1.5-2 s and up to 13 s on production.
    expect(trpcBatchLane('review.listPending')).toBe('review');
  });

  test("the Accounts page's own reads stay in the default lane (SC-1671)", () => {
    // The control: only the slow feed moves, so the page's reads still
    // arrive together in one request.
    expect(trpcBatchLane('accounts.getByUserIdWithSummary')).toBe('default');
    expect(trpcBatchLane('groups.getAll')).toBe('default');
    expect(trpcBatchLane('institutions.getByUserId')).toBe('default');
    expect(trpcBatchLane('accountTypes.getAll')).toBe('default');
  });

  test('the household read rides its own lane, off every fast batch (SC-1743)', () => {
    // Production p90 0.7 s. In the default lane it held Settings > Data's
    // backup, bills calendar and AI rows past the reveal, then all of them
    // landed at once and pushed the page down by 1,161 px.
    expect(trpcBatchLane('household.mine')).toBe('household');
  });

  test('a caller can send a read to a lane, without moving it for everyone (SC-1743)', () => {
    // Household's share switches ask for the accounts summary (production p90
    // 1.35 s) in the household lane. The Accounts page asks for the same read
    // with no lane and keeps its one batch: the SC-1671 control above.
    expect(trpcBatchLane('accounts.getByUserIdWithSummary', { lane: 'household' })).toBe(
      'household'
    );
    expect(trpcBatchLane('accounts.getByUserIdWithSummary', {})).toBe('default');
    // Only a lane that exists is honoured.
    expect(trpcBatchLane('users.getCurrent', { lane: 'nowhere' })).toBe('default');
  });

  test('dashboard.* keeps the lane it already had', () => {
    expect(trpcBatchLane('dashboard.getOverview')).toBe('dashboard');
    expect(trpcBatchLane('dashboard.getAssetAllocation')).toBe('dashboard');
  });
});
