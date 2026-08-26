process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import {
  completeMonthWindow,
  ObservedBurnService,
} from '../../../src/services/payments/ObservedBurnService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * SC-657. Burn measured as the rate money leaves the tracked perimeter, not
 * as a schedule of recurring payments.
 *
 * The stubs implement only what the service calls. A dependency it grows
 * without being stubbed here fails loudly rather than silently resolving the
 * container itself.
 */

const BASE = 'base-token';

interface Row {
  id: string;
  holdingId: string;
  tokenId: string | null;
  quantity: string;
  occurredAt: Date;
  kind: string;
  transferReview: string | null;
  priceNative?: string | null;
  priceNativeTokenId?: string | null;
}

function row(over: Partial<Row> & { occurredAt: Date }): Row {
  return {
    id: `tx-${Math.abs(over.occurredAt.getTime())}-${over.transferReview ?? 'null'}`,
    holdingId: 'h1',
    tokenId: 'usd',
    quantity: '-1000',
    kind: 'transfer_out',
    transferReview: 'left_control',
    priceNative: null,
    priceNativeTokenId: null,
    ...over,
  };
}

/** Values every leg at 1:1 in base, so the arithmetic under test is the sum. */
function makeService(rows: Row[], opts: { unvaluable?: Set<string>; stale?: Set<string> } = {}) {
  Container.set(HoldingTransactionRepository, {
    findByRange: async (o: { from?: Date; to?: Date }) =>
      rows.filter((r) => (!o.from || r.occurredAt >= o.from) && (!o.to || r.occurredAt < o.to)),
  } as unknown as HoldingTransactionRepository);

  Container.set(HoldingRepository, {
    findByIds: async (ids: string[]) => ids.map((id) => ({ id, tokenId: null })),
  } as unknown as HoldingRepository);

  Container.set(PriceGraphService, {
    buildPriceLookup: async () => ({ covers: () => true }),
    convert: async (amount: unknown, from: string, _to: string) => {
      if (opts.unvaluable?.has(from)) return null;
      return { amount, stale: opts.stale?.has(from) ?? false };
    },
  } as unknown as PriceGraphService);

  const instance = new ObservedBurnService();
  Container.set(ObservedBurnService, instance);
  return instance;
}

describe('SC-657 — completeMonthWindow', () => {
  /**
   * The CURRENT month is excluded because it is partial. Averaging a month
   * that is three days old drags the mean down and makes the runway LONGER —
   * wrong in the flattering direction, the one direction this codebase
   * refuses to be wrong in.
   */
  test('ends with the month BEFORE today, never the partial current one', () => {
    const w = completeMonthWindow(new Date('2026-08-03T00:00:00Z'), 6);
    expect(w.months).toEqual(['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']);
    expect(w.to.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(w.from.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  test('the window always has exactly windowMonths months', () => {
    for (const months of [1, 3, 6, 12]) {
      expect(completeMonthWindow(new Date('2026-08-03T00:00:00Z'), months).months).toHaveLength(
        months
      );
    }
  });

  test('it crosses a year boundary without losing a month', () => {
    const w = completeMonthWindow(new Date('2026-02-15T00:00:00Z'), 4);
    expect(w.months).toEqual(['2025-10', '2025-11', '2025-12', '2026-01']);
  });
});

describe('SC-657 — only left_control counts as a perimeter exit', () => {
  const asOf = new Date('2026-08-03T00:00:00Z');

  test('left_control is counted; every other answer is excluded and NAMED', async () => {
    const service = makeService([
      row({ occurredAt: new Date('2026-07-05T00:00:00Z'), transferReview: 'left_control' }),
      row({ occurredAt: new Date('2026-07-06T00:00:00Z'), transferReview: 'untracked' }),
      row({ occurredAt: new Date('2026-07-07T00:00:00Z'), transferReview: 'paired' }),
      row({ occurredAt: new Date('2026-07-08T00:00:00Z'), transferReview: 'internal' }),
      row({ occurredAt: new Date('2026-07-09T00:00:00Z'), transferReview: null }),
    ]);
    const burn = await service.observed('u1', BASE, asOf, 6);

    expect(burn.total).toBe('1000');
    expect(burn.countedTransactions).toBe(1);
    expect(burn.excluded).toEqual({
      unclassified: 1,
      untracked: 1,
      internal: 2,
      unvalued: 0,
    });
  });

  /**
   * `untracked` means "still the user's money, in an account Scani cannot
   * see". Coin moved to a cold wallet is wealth changing address, not money
   * spent. Counting it reports a burn nobody incurred — and this is the axis
   * an implementation that treats the two answers as synonyms gets wrong.
   */
  test('a wallet full of untracked moves produces a burn of zero, not a false burn', async () => {
    const service = makeService([
      row({ occurredAt: new Date('2026-06-05T00:00:00Z'), transferReview: 'untracked' }),
      row({ occurredAt: new Date('2026-07-05T00:00:00Z'), transferReview: 'untracked' }),
    ]);
    const burn = await service.observed('u1', BASE, asOf, 6);

    expect(burn.total).toBe('0');
    expect(burn.perMonthMean).toBe('0');
    expect(burn.excluded.untracked).toBe(2);
  });

  /**
   * The unanswered rows must never read as zero silently — that is a
   * confident zero indistinguishable from having looked and found nothing.
   */
  test('unanswered outflows are surfaced as a count, not absorbed', async () => {
    const service = makeService(
      Array.from({ length: 35 }, (_, i) =>
        row({ occurredAt: new Date('2026-07-05T00:00:00Z'), transferReview: null, id: `n${i}` })
      )
    );
    const burn = await service.observed('u1', BASE, asOf, 6);
    expect(burn.excluded.unclassified).toBe(35);
    expect(burn.total).toBe('0');
  });
});

describe('SC-657 — the statistic', () => {
  const asOf = new Date('2026-08-03T00:00:00Z');

  /**
   * The mean divides by the WINDOW, not by the months that happened to carry
   * a movement: a month he moved nothing out is a real zero and belongs in
   * the average. Dividing by non-empty months only would report a HIGHER
   * burn the quieter he got.
   */
  test('the mean divides by the window, so quiet months count', async () => {
    const service = makeService([
      row({ occurredAt: new Date('2026-07-05T00:00:00Z'), quantity: '-6000' }),
    ]);
    const burn = await service.observed('u1', BASE, asOf, 6);

    expect(burn.total).toBe('6000');
    expect(burn.perMonthMean).toBe('1000');
    expect(burn.perMonth).toHaveLength(6);
    expect(burn.perMonth.filter((m) => m.amount === '0')).toHaveLength(5);
  });

  /**
   * Mean and median differ MATERIALLY over his real spread, which is why the
   * choice is a product decision and why both travel to the surface. On
   * 4k/43k-shaped data the median would describe a typical month and let a
   * runway survive on paper past the point the account is empty.
   */
  test('mean and median are both reported and are not the same number', async () => {
    const service = makeService([
      row({ occurredAt: new Date('2026-02-05T00:00:00Z'), quantity: '-4000' }),
      row({ occurredAt: new Date('2026-03-05T00:00:00Z'), quantity: '-5000' }),
      row({ occurredAt: new Date('2026-04-05T00:00:00Z'), quantity: '-4000' }),
      row({ occurredAt: new Date('2026-05-05T00:00:00Z'), quantity: '-6000' }),
      row({ occurredAt: new Date('2026-06-05T00:00:00Z'), quantity: '-21000' }),
      row({ occurredAt: new Date('2026-07-05T00:00:00Z'), quantity: '-43000' }),
    ]);
    const burn = await service.observed('u1', BASE, asOf, 6);

    // Rounded on purpose: 83000/6 repeats, and pinning 25 digits of it tests
    // Decimal's precision setting rather than this service's arithmetic.
    expect(new Decimal(burn.perMonthMean).toFixed(2)).toBe('13833.33');
    expect(burn.perMonthMedian).toBe('5500');
    expect(burn.perMonthMin).toBe('4000');
    expect(burn.perMonthMax).toBe('43000');
    // The whole reason both are on the surface.
    expect(burn.perMonthMean).not.toBe(burn.perMonthMedian);
  });

  /**
   * A perimeter exit nobody can price is NOT worth zero. Dropping it silently
   * understates the burn and lengthens the runway — flattering again — so it
   * leaves the total and arrives as a count the surface can say out loud.
   */
  test('an exit that cannot be valued is counted as unvalued, never as zero', async () => {
    const service = makeService(
      [
        row({ occurredAt: new Date('2026-07-05T00:00:00Z'), quantity: '-3000', tokenId: 'usd' }),
        row({
          occurredAt: new Date('2026-07-06T00:00:00Z'),
          quantity: '-9999',
          tokenId: 'obscure',
        }),
      ],
      { unvaluable: new Set(['obscure']) }
    );
    const burn = await service.observed('u1', BASE, asOf, 6);

    expect(burn.total).toBe('3000');
    expect(burn.excluded.unvalued).toBe(1);
    expect(burn.countedTransactions).toBe(1);
  });

  /** A leg valued off a 96-day-old quote is otherwise indistinguishable from
   * one priced on the day (SC-151). It counts, and it says so. */
  test('a stale valuation still counts, and travels with its own count', async () => {
    const service = makeService(
      [row({ occurredAt: new Date('2026-07-05T00:00:00Z'), quantity: '-2000', tokenId: 'thin' })],
      { stale: new Set(['thin']) }
    );
    const burn = await service.observed('u1', BASE, asOf, 6);

    expect(burn.total).toBe('2000');
    expect(burn.staleValued).toBe(1);
    expect(burn.excluded.unvalued).toBe(0);
  });

  test('an account with no outflows at all is zero everywhere, with a full window', async () => {
    const service = makeService([]);
    const burn = await service.observed('u1', BASE, asOf, 6);
    expect(burn.total).toBe('0');
    expect(burn.perMonth).toHaveLength(6);
    expect(burn.fromMonth).toBe('2026-02');
    expect(burn.toMonth).toBe('2026-07');
  });
});
