import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { PaymentOccurrenceRepository } from '../../../src/repositories/PaymentOccurrenceRepository';
import { PortfolioValueDailyRepository } from '../../../src/repositories/PortfolioValueDailyRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { WeeklyDigestService } from '../../../src/services/digest/WeeklyDigestService';
import { TransferReviewService } from '../../../src/services/TransferReviewService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

const NOW = new Date('2026-08-19T09:00:00.000Z');
const USER = { id: 'user-1', baseCurrencyId: 'usd-token' };

interface RollupRow {
  snapshotDate: string;
  totalValue: string;
  holdingsTotal: number;
}

interface HoldingRow {
  snapshotDate: string;
  holdingId: string;
  totalValue: string;
}

function makeService(opts: {
  userRows?: RollupRow[];
  holdingRows?: HoldingRow[];
  bills?: Array<{ vendorName: string; dueDate: string; expectedAmount: string | null }>;
  pending?: number;
}): WeeklyDigestService {
  Container.set(PortfolioValueDailyRepository, {
    findRange: async () => opts.userRows ?? [],
    findIncludedHoldingScopeRange: async () => opts.holdingRows ?? [],
  });
  Container.set(HoldingRepository, {
    findByIds: async (ids: string[]) => ids.map((id) => ({ id, tokenId: `token-${id}` })),
  });
  Container.set(TokenRepository, {
    findById: async () => ({ id: 'usd-token', symbol: 'USD' }),
    findByIds: async (ids: string[]) =>
      ids.map((id) => ({ id, symbol: id.replace('token-holding-', '').toUpperCase() })),
  });
  Container.set(PaymentOccurrenceRepository, {
    findDueBetweenForUser: async () =>
      (opts.bills ?? []).map((b) => ({
        occurrenceId: 'occ',
        dueDate: b.dueDate,
        expectedAmount: b.expectedAmount,
        currencyTokenId: 'eur-token',
        currencySymbol: 'EUR',
        vendorName: b.vendorName,
      })),
  });
  Container.set(TransferReviewService, {
    pendingSummary: async () => ({ count: opts.pending ?? 0, latestCreatedAt: null }),
  });
  const instance = new WeeklyDigestService();
  Container.set(WeeklyDigestService, instance);
  return instance;
}

describe('WeeklyDigestService — the do-not-mail guardrail (SC-460)', () => {
  test('an account with no rollup row at all is skipped as no-snapshot', async () => {
    const outcome = await makeService({ userRows: [] }).buildFor(USER, NOW);
    expect(outcome.skipped).toBe('no-snapshot');
  });

  test('an account whose portfolio is empty is skipped, not mailed a zero', async () => {
    // 8 of the 15 accounts on SC-450's funnel are this case. A digest that
    // reports nothing converts interest into a spam report.
    const outcome = await makeService({
      userRows: [{ snapshotDate: '2026-08-18', totalValue: '0', holdingsTotal: 0 }],
    }).buildFor(USER, NOW);
    expect(outcome.skipped).toBe('no-holdings');
  });

  test('a rollup that stopped running is skipped as stale, NOT as empty', async () => {
    // The two reasons need different people to do different things: one is a
    // userbase fact, the other is the nightly rollup being broken.
    const outcome = await makeService({
      userRows: [{ snapshotDate: '2026-08-01', totalValue: '1000', holdingsTotal: 3 }],
    }).buildFor(USER, NOW);
    expect(outcome.skipped).toBe('stale-snapshot');
  });
});

describe('WeeklyDigestService — the figures', () => {
  test('quotes the newest snapshot and the change over seven days', async () => {
    const outcome = await makeService({
      userRows: [
        { snapshotDate: '2026-08-11', totalValue: '100000', holdingsTotal: 3 },
        { snapshotDate: '2026-08-18', totalValue: '102500', holdingsTotal: 3 },
      ],
    }).buildFor(USER, NOW);

    expect(outcome.digest?.netWorth).toBe('$102,500.00');
    expect(outcome.digest?.asOf).toBe('2026-08-18');
    expect(outcome.digest?.change?.amount).toBe('+$2,500.00');
    expect(outcome.digest?.change?.percent).toBe('+2.5%');
    expect(outcome.digest?.change?.direction).toBe('up');
  });

  test('a missed rollup night compares against the nearest earlier row', async () => {
    const outcome = await makeService({
      userRows: [
        { snapshotDate: '2026-08-10', totalValue: '100000', holdingsTotal: 3 },
        { snapshotDate: '2026-08-18', totalValue: '90000', holdingsTotal: 3 },
      ],
    }).buildFor(USER, NOW);
    expect(outcome.digest?.change?.direction).toBe('down');
    expect(outcome.digest?.change?.amount).toBe('−$10,000.00');
  });

  test('with nothing to compare against, the digest still sends without a change', async () => {
    const outcome = await makeService({
      userRows: [{ snapshotDate: '2026-08-18', totalValue: '102500', holdingsTotal: 3 }],
    }).buildFor(USER, NOW);
    expect(outcome.digest?.change).toBeNull();
    expect(outcome.digest?.movers).toEqual([]);
  });

  test('ranks movers by absolute change and names them by token symbol', async () => {
    const outcome = await makeService({
      userRows: [
        { snapshotDate: '2026-08-11', totalValue: '100000', holdingsTotal: 2 },
        { snapshotDate: '2026-08-18', totalValue: '102500', holdingsTotal: 2 },
      ],
      holdingRows: [
        { snapshotDate: '2026-08-11', holdingId: 'holding-btc', totalValue: '50000' },
        { snapshotDate: '2026-08-18', holdingId: 'holding-btc', totalValue: '53000' },
        { snapshotDate: '2026-08-11', holdingId: 'holding-eth', totalValue: '50000' },
        { snapshotDate: '2026-08-18', holdingId: 'holding-eth', totalValue: '49500' },
      ],
    }).buildFor(USER, NOW);

    expect(outcome.digest?.movers.map((m) => m.symbol)).toEqual(['BTC', 'ETH']);
    expect(outcome.digest?.movers[0]?.amount).toBe('+$3,000.00');
    expect(outcome.digest?.movers[1]?.direction).toBe('down');
  });

  test('a holding that only exists on one of the two dates is not a mover', async () => {
    // An import that landed mid-week would otherwise be the biggest gainer
    // every time, which is a fact about the import, not about the market.
    const outcome = await makeService({
      userRows: [
        { snapshotDate: '2026-08-11', totalValue: '100000', holdingsTotal: 2 },
        { snapshotDate: '2026-08-18', totalValue: '150000', holdingsTotal: 2 },
      ],
      holdingRows: [{ snapshotDate: '2026-08-18', holdingId: 'holding-new', totalValue: '50000' }],
    }).buildFor(USER, NOW);
    expect(outcome.digest?.movers).toEqual([]);
  });

  test('bills are listed in the bill currency and the overflow is counted', async () => {
    const outcome = await makeService({
      userRows: [{ snapshotDate: '2026-08-18', totalValue: '102500', holdingsTotal: 3 }],
      bills: [
        { vendorName: 'Rent', dueDate: '2026-08-20', expectedAmount: '1200' },
        { vendorName: 'Water', dueDate: '2026-08-21', expectedAmount: null },
        { vendorName: 'Phone', dueDate: '2026-08-22', expectedAmount: '40' },
        { vendorName: 'Gym', dueDate: '2026-08-24', expectedAmount: '30' },
      ],
    }).buildFor(USER, NOW);

    expect(outcome.digest?.bills).toHaveLength(3);
    expect(outcome.digest?.bills[0]?.amount).toBe('€1,200.00');
    // A variable bill with no estimate is carried as null, never as zero.
    expect(outcome.digest?.bills[1]?.amount).toBeNull();
    expect(outcome.digest?.moreBills).toBe(1);
  });

  test('carries the review-queue count through', async () => {
    const outcome = await makeService({
      userRows: [{ snapshotDate: '2026-08-18', totalValue: '102500', holdingsTotal: 3 }],
      pending: 7,
    }).buildFor(USER, NOW);
    expect(outcome.digest?.reviewCount).toBe(7);
  });
});
