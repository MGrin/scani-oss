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

  test('dashboard.* keeps the lane it already had', () => {
    expect(trpcBatchLane('dashboard.getOverview')).toBe('dashboard');
    expect(trpcBatchLane('dashboard.getAssetAllocation')).toBe('dashboard');
  });
});
