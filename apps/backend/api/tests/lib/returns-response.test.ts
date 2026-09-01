import { describe, expect, test } from 'bun:test';
import type { ReturnsResult } from '@scani/domain/services';
import { withoutPeriodSeries } from '../../src/lib/returns-response';

/**
 * SC-471 — the sub-period series is trimmed from the WIRE, never from the
 * computation.
 *
 * `portfolio.getReturns` sent one entry per measured day on every call: one
 * per day of history over `all` on an account with real history, and most of
 * the response by size, for a screen that prints two numbers. The series itself has to
 * survive — SC-458 attributes FX per sub-period and SC-464 chains a benchmark
 * over the same boundaries, and neither can be re-derived from the scalar.
 *
 * SC-458 put a SECOND per-sub-period series in the same payload — the asset
 * and currency legs over the same boundaries — behind the same flag. One flag
 * for both is deliberate: a client handed the TWR periods without the
 * attribution periods could not line the two up.
 */

function period(from: string, to: string) {
  return {
    from,
    to,
    startValue: '100',
    endValue: '110',
    netExternalFlow: '0',
    return: '0.1',
    measured: true,
  };
}

const ATTRIBUTION: ReturnsResult['attribution'] = {
  assetReturn: '0.1',
  currencyReturn: '0.1',
  baseReturn: '0.21',
  crossTerm: '0.01',
  attributedPeriods: 2,
  unattributedPeriods: 0,
  unpricedCurrencyPeriods: 0,
  currencies: [{ currencyTokenId: 'token-eur', endWeight: '1' }],
  periods: [
    {
      from: '2026-01-01',
      to: '2026-02-01',
      assetReturn: '0.05',
      currencyReturn: '0.05',
      reason: null,
    },
    {
      from: '2026-02-01',
      to: '2026-03-01',
      assetReturn: '0.05',
      currencyReturn: '0.05',
      reason: null,
    },
  ],
};

function result(
  twr: ReturnsResult['twr'],
  attribution: ReturnsResult['attribution'] = ATTRIBUTION
): ReturnsResult {
  return {
    scope: { kind: 'user' },
    baseCurrencyId: 'token-usd',
    requestedWindow: { kind: 'all', from: '2026-01-01', to: '2026-03-01' },
    effectiveWindow: { from: '2026-01-01', to: '2026-03-01' },
    startValue: '100',
    endValue: '121',
    netExternalFlow: '0',
    twr,
    attribution,
    xirr: {
      status: 'ok',
      rate: 0.21,
      method: 'bisection',
      iterations: 3,
      uniqueRoot: true,
    },
    coverage: {
      measuredDays: 3,
      windowDays: 60,
      daysNotFullyCovered: 0,
      skippedPeriods: 0,
      unvaluedFlows: 0,
      staleValuedFlows: 0,
      flowsAfterLastMeasuredDay: 0,
    },
  };
}

const TWR: ReturnsResult['twr'] = {
  cumulative: '0.21',
  annualized: null,
  periods: [period('2026-01-01', '2026-02-01'), period('2026-02-01', '2026-03-01')],
  measuredPeriods: 2,
  skippedPeriods: 0,
  spanDays: 59,
};

describe('withoutPeriodSeries', () => {
  test('drops the key rather than emptying it', () => {
    // `periods: []` would assert the window had no sub-periods. The absence
    // says only that they were not requested, which is what happened — so a
    // client reading `periods?.length` gets `undefined`, not a confident 0.
    const trimmed = withoutPeriodSeries(result(TWR));
    expect('periods' in (trimmed.twr as object)).toBe(false);
  });

  test('everything else survives, including how many periods there were', () => {
    const trimmed = withoutPeriodSeries(result(TWR));
    expect(trimmed.twr?.cumulative).toBe('0.21');
    expect(trimmed.twr?.measuredPeriods).toBe(2);
    expect(trimmed.twr?.skippedPeriods).toBe(0);
    expect(trimmed.twr?.spanDays).toBe(59);
    expect(trimmed.startValue).toBe('100');
    expect(trimmed.coverage.measuredDays).toBe(3);
  });

  test('does not mutate the result the caller still holds', () => {
    // The service's own object goes on to SC-458 and SC-464 inside the same
    // process. Trimming a copy is the whole point.
    const original = result(TWR);
    withoutPeriodSeries(original);
    expect(original.twr?.periods.length).toBe(2);
  });

  test('a window too short to have a TWR stays null, not an empty object', () => {
    // Fewer than two measured days is an absence, and the CTA the client
    // renders for it is different from the one it renders for a zero.
    expect(withoutPeriodSeries(result(null, null)).twr).toBeNull();
  });

  test('the FX attribution loses its series and keeps its numbers (SC-458)', () => {
    const trimmed = withoutPeriodSeries(result(TWR));
    expect('periods' in (trimmed.attribution as object)).toBe(false);
    expect(trimmed.attribution?.assetReturn).toBe('0.1');
    expect(trimmed.attribution?.currencyReturn).toBe('0.1');
    expect(trimmed.attribution?.baseReturn).toBe('0.21');
    expect(trimmed.attribution?.attributedPeriods).toBe(2);
    expect(trimmed.attribution?.unattributedPeriods).toBe(0);
    expect(trimmed.attribution?.currencies).toEqual([
      { currencyTokenId: 'token-eur', endWeight: '1' },
    ]);
  });

  test('an attribution that could not be made stays null, not an empty split', () => {
    // `0% asset / 0% currency` is a measurement. "Nothing here could be
    // attributed" is not, and rendering the second as the first is the whole
    // failure mode SC-458 is written against.
    expect(withoutPeriodSeries(result(TWR, null)).attribution).toBeNull();
  });

  test('does not mutate the attribution the caller still holds', () => {
    const original = result(TWR);
    withoutPeriodSeries(original);
    expect(original.attribution?.periods.length).toBe(2);
  });
});
