import { describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import {
  BenchmarkReturnService,
  type ReturnsRequest,
  ReturnsService,
} from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { _resetReturnsCache } from '../../../src/lib/returns-cache';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1159: `getReturns` hands Home's card the engine's answer for the CALLER,
// user-wide, without the per-period series the card never reads.

restoreContainerAfterAll();

const USER = {
  id: '00000000-0000-4000-8000-00000000000a',
  email: 'a@scani.local',
} as typeof schema.users.$inferSelect;

const benchmarkWindows: Array<{ from: string; to: string }> = [];
const pricedDays: string[][] = [];
Container.set(BenchmarkReturnService, {
  over: async (window: { from: string; to: string }) => {
    benchmarkWindows.push(window);
    return [{ key: 'btc', cumulative: '0.5' }];
  },
  pricesOn: async (days: string[]) => {
    pricedDays.push(days);
    // Flat: the benchmark goes nowhere, so every gap is the portfolio's own.
    return new Map([['btc', new Map(days.map((day) => [day, new Decimal(10)]))]]);
  },
} as unknown as BenchmarkReturnService);

function stub(outcome: unknown, hasHistory = true) {
  // A fresh engine per test, so a run shared from an earlier test's engine
  // would answer with that test's outcome.
  _resetReturnsCache();
  const asked: ReturnsRequest[] = [];
  Container.set(ReturnsService, {
    compute: async (request: ReturnsRequest) => {
      asked.push(request);
      return outcome;
    },
    hasHistory: async (request: ReturnsRequest) => {
      historyAsked.push(request);
      return hasHistory;
    },
  } as unknown as ReturnsService);
  return asked;
}

/** Every `hasHistory` the router issued, in call order. */
const historyAsked: ReturnsRequest[] = [];

const RESULT = {
  scope: { kind: 'user' },
  baseCurrencyId: 'usd',
  requestedWindow: { kind: 'ytd', from: '2026-01-01', to: '2026-09-19' },
  effectiveWindow: { from: '2026-01-01', to: '2026-09-19' },
  startValue: '100',
  endValue: '130',
  netExternalFlow: '0',
  series: [
    { date: '2026-01-01', value: '100', netExternalFlow: '0' },
    { date: '2026-09-19', value: '130', netExternalFlow: '0' },
  ],
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

  /**
   * A screen asks for its own days now (SC-1305).
   *
   * This test used to assert the opposite — `a custom window is refused:
   * nothing on screen sends one` — and the refusal was correct for as long as
   * that was true. It stopped being true when the home chart's period control
   * was wired to this procedure: with only `ytd | 1y | all` on offer, 1M, 3M
   * and 6M were all mapped onto `1y`, so moving the control produced the
   * identical request and changed nothing a reader could see.
   */
  test('a screen asks for exactly the days it draws', async () => {
    const asked = stub({ status: 'ok', returns: RESULT });
    await makeAuthedCaller(USER).portfolio.getReturns({
      window: {
        kind: 'custom',
        from: new Date('2026-03-01T00:00:00.000Z'),
        to: new Date('2026-04-01T00:00:00.000Z'),
      },
    });
    expect(asked).toEqual([
      {
        userId: '00000000-0000-4000-8000-00000000000a',
        scope: { kind: 'user' },
        window: {
          kind: 'custom',
          from: new Date('2026-03-01T00:00:00.000Z'),
          to: new Date('2026-04-01T00:00:00.000Z'),
        },
      },
    ]);
  });

  test('two different ranges are two different requests — the control moves the query', async () => {
    const asked = stub({ status: 'ok', returns: RESULT });
    const caller = makeAuthedCaller(USER);
    await caller.portfolio.getReturns({
      window: {
        kind: 'custom',
        from: new Date('2026-08-24T00:00:00.000Z'),
        to: new Date('2026-09-23T00:00:00.000Z'),
      },
    });
    await caller.portfolio.getReturns({
      window: {
        kind: 'custom',
        from: new Date('2026-06-25T00:00:00.000Z'),
        to: new Date('2026-09-23T00:00:00.000Z'),
      },
    });
    expect(asked).toHaveLength(2);
    expect(asked[0]?.window).not.toEqual(
      asked[1]?.window as NonNullable<(typeof asked)[number]>['window']
    );
  });

  /**
   * The bound is SERVER-side, and both arms matter.
   *
   * The engine reads one rollup row per day between the two dates the client
   * chose, so an unbounded range is a client-chosen amount of work. `all` is
   * still unbounded on purpose: its length is a fact about the caller's own
   * history rather than a number they typed.
   */
  test('a range longer than ten years is refused, and the engine is never asked', async () => {
    const asked = stub({ status: 'ok', returns: RESULT });
    await expect(
      makeAuthedCaller(USER).portfolio.getReturns({
        window: {
          kind: 'custom',
          from: new Date('1990-01-01T00:00:00.000Z'),
          to: new Date('2026-09-23T00:00:00.000Z'),
        },
      })
    ).rejects.toThrow();
    expect(asked).toEqual([]);
  });

  test('a range that ends before it starts is refused', async () => {
    const asked = stub({ status: 'ok', returns: RESULT });
    await expect(
      makeAuthedCaller(USER).portfolio.getReturns({
        window: {
          kind: 'custom',
          from: new Date('2026-09-23T00:00:00.000Z'),
          to: new Date('2026-08-24T00:00:00.000Z'),
        },
      })
    ).rejects.toThrow();
    expect(asked).toEqual([]);
  });

  test('the named windows are untouched — the account and institution cards still send them', async () => {
    for (const kind of ['ytd', '1y', 'all'] as const) {
      const asked = stub({ status: 'ok', returns: RESULT });
      await makeAuthedCaller(USER).portfolio.getReturns({ window: { kind } });
      expect(asked[0]?.window).toEqual({ kind });
    }
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

describe('portfolio.getReturnsComparison (SC-1297)', () => {
  test('the card gets its money change, its split, and a line per benchmark', async () => {
    stub({ status: 'ok', returns: RESULT });
    const { comparison, baseCurrencyId, truncated } = await makeAuthedCaller(
      USER
    ).portfolio.getReturnsComparison({ window: { kind: 'ytd' } });

    expect(baseCurrencyId).toBe('usd');
    expect(truncated).toBe(false);
    expect(comparison?.headline).toEqual({
      change: '30',
      from: '2026-01-01',
      to: '2026-09-19',
    });
    // Nothing was put in, so the whole change is the portfolio's own doing.
    expect(comparison?.attribution.contributions).toBe('0');
    expect(comparison?.attribution.gain).toBe('30');
    // A flat benchmark holds the opening 100, leaving the reader 30 ahead.
    expect(comparison?.gaps).toEqual([{ key: 'btc', money: '30', benchmarkValue: '100' }]);
    expect(comparison?.chart).toHaveLength(2);
  });

  test('prices are asked for only on the days the portfolio was measured', async () => {
    pricedDays.length = 0;
    stub({ status: 'ok', returns: RESULT });
    await makeAuthedCaller(USER).portfolio.getReturnsComparison({ window: { kind: 'ytd' } });
    expect(pricedDays).toEqual([['2026-01-01', '2026-09-19']]);
  });

  test('separate requests over unchanged data price the benchmarks once (SC-1320)', async () => {
    // The prices were ~0.6s of every call once the returns run was shared.
    pricedDays.length = 0;
    stub({ status: 'ok', returns: RESULT });
    const first = await makeAuthedCaller(USER).portfolio.getReturnsComparison({
      window: { kind: 'ytd' },
    });
    for (let i = 0; i < 2; i++) {
      expect(
        await makeAuthedCaller(USER).portfolio.getReturnsComparison({ window: { kind: 'ytd' } })
      ).toEqual(first);
    }
    expect(pricedDays).toHaveLength(1);

    // The control: a key that ignored the window would price once here too.
    await makeAuthedCaller(USER).portfolio.getReturnsComparison({ window: { kind: '1y' } });
    expect(pricedDays).toHaveLength(2);
  });

  test('a window that measured nothing is an absence, not an empty chart', async () => {
    stub({ status: 'ok', returns: { ...RESULT, series: [] } });
    expect(
      await makeAuthedCaller(USER).portfolio.getReturnsComparison({ window: { kind: 'all' } })
    ).toEqual({ comparison: null, baseCurrencyId: null, truncated: false });
  });

  test('an account the caller does not own is not found, and the engine is never asked', async () => {
    const asked = stub({ status: 'ok', returns: RESULT });
    await expect(
      makeAuthedCaller(USER).portfolio.getReturnsComparison({
        window: { kind: 'ytd' },
        scope: { kind: 'account', id: '00000000-0000-4000-8000-000000000001' },
      })
    ).rejects.toThrow('Account not found');
    expect(asked).toEqual([]);
  });
});

describe('portfolio.hasReturns (SC-1306)', () => {
  test('answers the one bit without running the engine', async () => {
    historyAsked.length = 0;
    const asked = stub({ status: 'ok', returns: RESULT }, true);
    const result = await makeAuthedCaller(USER).portfolio.hasReturns({ window: { kind: 'ytd' } });

    expect(result).toEqual({ hasReturns: true });
    expect(asked).toEqual([]);
    expect(historyAsked).toEqual([
      { userId: USER.id, scope: { kind: 'user' }, window: { kind: 'ytd' } },
    ]);
  });

  test('carries a custom window through unchanged', async () => {
    historyAsked.length = 0;
    stub({ status: 'ok', returns: RESULT }, false);
    const from = new Date('2026-06-01T00:00:00.000Z');
    const to = new Date('2026-09-01T00:00:00.000Z');
    const result = await makeAuthedCaller(USER).portfolio.hasReturns({
      window: { kind: 'custom', from, to },
    });

    // A bit answered about a DIFFERENT window than the tab will show is worse
    // than no bit: the tab appears and then has nothing behind it.
    expect(result).toEqual({ hasReturns: false });
    expect(historyAsked[0]?.window).toEqual({ kind: 'custom', from, to });
  });
});

describe('one engine run per request, not one per procedure (SC-1306)', () => {
  test('both procedures in one request compute the window once', async () => {
    const asked = stub({ status: 'ok', returns: RESULT });
    const caller = makeAuthedCaller(USER);
    await Promise.all([
      caller.portfolio.getReturns({ window: { kind: 'ytd' } }),
      caller.portfolio.getReturnsComparison({ window: { kind: 'ytd' } }),
    ]);
    expect(asked.length).toBe(1);
  });

  test('a DIFFERENT window in the same request is a different answer', async () => {
    // The control that a key which ignored the window would fail. Sharing one
    // run across two windows would print a YTD return under a 1-year axis.
    const asked = stub({ status: 'ok', returns: RESULT });
    const caller = makeAuthedCaller(USER);
    await Promise.all([
      caller.portfolio.getReturns({ window: { kind: 'ytd' } }),
      caller.portfolio.getReturns({ window: { kind: '1y' } }),
    ]);
    // Order-free: each run first awaits its data-version read, so two
    // concurrent windows may start in either order. A key that ignored the
    // window would still fail here, with ONE run instead of two.
    expect(asked.map((r) => r.window.kind).sort()).toEqual(['1y', 'ytd']);
  });

  test('a SEPARATE request over unchanged data shares the run (2026-09-24)', async () => {
    // This asserted the opposite until the 2026-09-24 incident: a run is ~2s
    // of CPU on a single-threaded api, so every reload recomputing it stalled
    // other requests. It is shared now while the data version holds;
    // `tests/lib/returns-cache.test.ts` covers the cases that must NOT share.
    const asked = stub({ status: 'ok', returns: RESULT });
    await makeAuthedCaller(USER).portfolio.getReturns({ window: { kind: 'ytd' } });
    await makeAuthedCaller(USER).portfolio.getReturns({ window: { kind: 'ytd' } });
    expect(asked.length).toBe(1);
  });

  test('two reloads of Home share the run — its window is anchored to the second it loaded (SC-1322)', async () => {
    // `returnsWindowRequest` sends `{ from: now - 30d, to: now }`, so two
    // reloads a minute apart send two different pairs of instants over the same
    // two days. Keyed on the instants, every Home load recomputed the run.
    const asked = stub({ status: 'ok', returns: RESULT });
    const home = (to: string) => ({
      window: {
        kind: 'custom' as const,
        from: new Date(new Date(to).getTime() - 30 * 24 * 60 * 60 * 1000),
        to: new Date(to),
      },
    });
    await makeAuthedCaller(USER).portfolio.getReturns(home('2026-09-25T09:24:45.123Z'));
    await makeAuthedCaller(USER).portfolio.getReturns(home('2026-09-25T09:24:59.456Z'));
    await makeAuthedCaller(USER).portfolio.getReturns(home('2026-09-25T09:25:02.789Z'));
    expect(asked.length).toBe(1);
  });

  test('control: the same window a day later is a different run', async () => {
    const asked = stub({ status: 'ok', returns: RESULT });
    const home = (to: string) => ({
      window: {
        kind: 'custom' as const,
        from: new Date(new Date(to).getTime() - 30 * 24 * 60 * 60 * 1000),
        to: new Date(to),
      },
    });
    await makeAuthedCaller(USER).portfolio.getReturns(home('2026-09-25T23:59:59.000Z'));
    await makeAuthedCaller(USER).portfolio.getReturns(home('2026-09-26T00:00:01.000Z'));
    expect(asked.length).toBe(2);
  });
});

describe('the daily series does not ride along on getReturns (SC-471, SC-1297)', () => {
  test('a card that shows two numbers is not sent one entry per measured day', async () => {
    stub({ status: 'ok', returns: RESULT });
    const { returns } = await makeAuthedCaller(USER).portfolio.getReturns({
      window: { kind: 'ytd' },
    });
    expect(returns && 'series' in returns).toBe(false);
  });
});
