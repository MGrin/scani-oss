import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { returnsView } from '../../../src/v3/lib/returns';

type Input = Parameters<typeof returnsView>[0];

function returns(overrides: Record<string, unknown> = {}): Input {
  return {
    requestedWindow: { kind: 'ytd', from: '2026-01-01', to: '2026-09-19' },
    effectiveWindow: { from: '2026-01-01', to: '2026-09-19' },
    twr: {
      cumulative: '0.25',
      annualized: null,
      measuredPeriods: 262,
      skippedPeriods: 0,
      spanDays: 262,
    },
    xirr: { status: 'ok', rate: 0.4, method: 'bisection', iterations: 30, uniqueRoot: true },
    coverage: {
      measuredDays: 263,
      windowDays: 263,
      daysNotFullyCovered: 0,
      skippedPeriods: 0,
      unvaluedFlows: 0,
      staleValuedFlows: 0,
      flowsAfterLastMeasuredDay: 0,
    },
    attribution: null,
    ...overrides,
  } as unknown as Input;
}

describe('returnsView (SC-1159)', () => {
  test('both figures, as percents', () => {
    const view = returnsView(returns());
    expect(view?.twr?.cumulative).toBeCloseTo(25, 2);
    expect(view?.twr?.annualized).toBeNull();
    expect(view?.xirr).toEqual({ rate: expect.closeTo(40, 2), approximate: false });
    expect(view?.since).toBeNull();
    expect(view?.partial).toBe(false);
  });

  test('no answer, or no history for either figure, is nothing to show', () => {
    expect(returnsView(null)).toBeNull();
    expect(
      returnsView(returns({ twr: null, xirr: { status: 'undefined', reason: 'too-few-flows' } }))
    ).toBeNull();
  });

  test('an XIRR with more than one root is shown as approximate', () => {
    const view = returnsView(
      returns({
        xirr: { status: 'ok', rate: 0.1, method: 'bisection', iterations: 9, uniqueRoot: false },
      })
    );
    expect(view?.xirr?.approximate).toBe(true);
  });

  test('"since" is said for All, and for a year only when history starts inside it', () => {
    const all = returns({
      requestedWindow: { kind: 'all', from: '1970-01-01', to: '2026-09-19' },
      effectiveWindow: { from: '2025-03-20', to: '2026-09-19' },
    });
    expect(returnsView(all)?.since).toBe('2025-03-20');
    const late = returns({ effectiveWindow: { from: '2026-05-02', to: '2026-09-19' } });
    expect(returnsView(late)?.since).toBe('2026-05-02');
  });

  test('a window not fully priced says so', () => {
    const base = returns();
    const partial = returns({
      coverage: { ...(base as { coverage: object }).coverage, daysNotFullyCovered: 3 },
    });
    expect(returnsView(partial)?.partial).toBe(true);
  });

  test('the exchange-rate split is shown when rates moved the result', () => {
    const view = returnsView(
      returns({
        attribution: { assetReturn: '0.2', currencyReturn: '0.05', unattributedPeriods: 0 },
      })
    );
    expect(view?.fx?.asset).toBeCloseTo(20, 2);
    expect(view?.fx?.currency).toBeCloseTo(5, 2);
  });

  test('no split, or rates that did nothing, shows no split', () => {
    expect(returnsView(returns())?.fx).toBeNull();
    const baseOnly = returns({
      attribution: { assetReturn: '0.25', currencyReturn: '0', unattributedPeriods: 0 },
    });
    expect(returnsView(baseOnly)?.fx).toBeNull();
  });

  test('a split that could not cover every period marks the window partial', () => {
    const view = returnsView(
      returns({
        attribution: { assetReturn: '0.2', currencyReturn: '0.05', unattributedPeriods: 2 },
      })
    );
    expect(view?.partial).toBe(true);
  });

  test('benchmarks become percents, and one with no price is left out', () => {
    const view = returnsView(returns(), [
      { key: 'btc', cumulative: '0.923' },
      { key: 'sp500', cumulative: null },
    ]);
    expect(view?.benchmarks).toEqual([{ key: 'btc', cumulative: expect.closeTo(92.3, 6) }]);
  });

  test('no benchmarks is an empty list, not a reason to hide the card', () => {
    expect(returnsView(returns())?.benchmarks).toEqual([]);
  });
});
