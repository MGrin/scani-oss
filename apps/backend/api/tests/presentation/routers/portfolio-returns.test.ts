import { describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import {
  BenchmarkReturnService,
  type ReturnsRequest,
  ReturnsService,
} from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1159: `getReturns` hands Home's card the engine's answer for the CALLER,
// user-wide, without the per-period series the card never reads.

restoreContainerAfterAll();

const USER = {
  id: '00000000-0000-4000-8000-00000000000a',
  email: 'a@scani.local',
} as typeof schema.users.$inferSelect;

const benchmarkWindows: Array<{ from: string; to: string }> = [];
Container.set(BenchmarkReturnService, {
  over: async (window: { from: string; to: string }) => {
    benchmarkWindows.push(window);
    return [{ key: 'btc', cumulative: '0.5' }];
  },
} as unknown as BenchmarkReturnService);

function stub(outcome: unknown) {
  const asked: ReturnsRequest[] = [];
  Container.set(ReturnsService, {
    compute: async (request: ReturnsRequest) => {
      asked.push(request);
      return outcome;
    },
  } as unknown as ReturnsService);
  return asked;
}

const RESULT = {
  scope: { kind: 'user' },
  baseCurrencyId: 'usd',
  requestedWindow: { kind: 'ytd', from: '2026-01-01', to: '2026-09-19' },
  effectiveWindow: { from: '2026-01-01', to: '2026-09-19' },
  startValue: '100',
  endValue: '130',
  netExternalFlow: '0',
  twr: {
    cumulative: '0.3',
    annualized: null,
    periods: [{}],
    measuredPeriods: 1,
    skippedPeriods: 0,
    spanDays: 262,
  },
  attribution: null,
  xirr: { status: 'ok', rate: 0.4, method: 'bisection', iterations: 9, uniqueRoot: true },
  coverage: {},
};

describe('portfolio.getReturns (SC-1159)', () => {
  test('asks for the caller, user-wide, over the chosen window, and drops the series', async () => {
    const asked = stub({ status: 'ok', returns: RESULT });
    const { returns } = await makeAuthedCaller(USER).portfolio.getReturns({
      window: { kind: 'ytd' },
    });
    expect(asked).toEqual([
      {
        userId: '00000000-0000-4000-8000-00000000000a',
        scope: { kind: 'user' },
        window: { kind: 'ytd' },
      },
    ]);
    expect(returns?.twr?.cumulative).toBe('0.3');
    expect(returns?.twr && 'periods' in returns.twr).toBe(false);
  });

  test('benchmarks are measured over the window the return was (SC-464)', async () => {
    benchmarkWindows.length = 0;
    stub({ status: 'ok', returns: RESULT });
    const { benchmarks } = await makeAuthedCaller(USER).portfolio.getReturns({
      window: { kind: 'ytd' },
    });
    expect(benchmarkWindows).toEqual([{ from: '2026-01-01', to: '2026-09-19' }]);
    expect(benchmarks).toEqual([{ key: 'btc', cumulative: '0.5' }]);
  });

  test('no base currency is nothing to show, not an error', async () => {
    stub({ status: 'no-base-currency' });
    expect(await makeAuthedCaller(USER).portfolio.getReturns({ window: { kind: 'all' } })).toEqual({
      returns: null,
      benchmarks: [],
    });
  });

  test('a custom window is refused: nothing on screen sends one', async () => {
    stub({ status: 'ok', returns: RESULT });
    await expect(
      makeAuthedCaller(USER).portfolio.getReturns({
        window: { kind: 'custom' } as unknown as { kind: 'ytd' },
      })
    ).rejects.toThrow();
  });

  test('an account the caller does not own is not found, and the engine is never asked', async () => {
    const asked = stub({ status: 'ok', returns: RESULT });
    await expect(
      makeAuthedCaller(USER).portfolio.getReturns({
        window: { kind: 'ytd' },
        scope: { kind: 'account', id: '00000000-0000-4000-8000-000000000001' },
      })
    ).rejects.toThrow('Account not found');
    expect(asked).toEqual([]);
  });
});
