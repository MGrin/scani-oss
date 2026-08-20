import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { BinanceProvider } from '../../src/providers/binance';
import { GateProvider } from '../../src/providers/gate';
import { MexcProvider } from '../../src/providers/mexc';
import { declaredHorizon, providerSources, substitutedWindow } from '../helpers/provider-sources';

/**
 * A provider that substitutes its own look-back for a missing `since` must
 * declare that look-back, or `TransactionRouter.claimsCompleteHistory` reads
 * the absence of a horizon as "reaches as far back as the account goes" and
 * writes `has_complete_tx_history = true` over a five-year window (SC-418,
 * SC-166).
 *
 * The horizon is DERIVED here from what the provider actually puts on the
 * wire, not compared against the constant it was written from. A test that
 * restated the constant would still pass if someone widened the default
 * window and left the declaration behind — which is the only way this
 * regresses, since nothing else reads the two together.
 */

function passthroughLimiter(): OutflowRateLimiter {
  return { execute: async <T>(fn: () => Promise<T>) => fn() } as unknown as OutflowRateLimiter;
}

const UNTIL = new Date('2026-06-01T00:00:00Z');

/** Query params each provider uses to name the start of a window. */
const START_PARAMS = ['startTime', 'startTimestamp', 'from'];
/** Gate sends seconds; Binance and MEXC send milliseconds. */
const SECONDS_PARAMS = new Set(['from']);

/**
 * Run a `since`-less `fetchTransactions` against a stubbed exchange and
 * return the earliest instant it asked about.
 */
async function earliestRequestedInstant(
  provider: { fetchTransactions: (ctx: never) => Promise<unknown> },
  balancesResponse: (url: string) => Response | null
): Promise<number> {
  const originalFetch = globalThis.fetch;
  const starts: number[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const query = new URL(url, 'https://stub.invalid').searchParams;
    for (const param of START_PARAMS) {
      const raw = query.get(param);
      if (raw === null) continue;
      const value = Number(raw);
      if (Number.isFinite(value)) starts.push(SECONDS_PARAMS.has(param) ? value * 1000 : value);
    }
    return balancesResponse(url) ?? new Response(JSON.stringify([]), { status: 200 });
  }) as typeof fetch;

  try {
    await provider.fetchTransactions({
      institutionCode: 'stub',
      baseCurrency: { id: 'usd', symbol: 'USD' },
      credentialsRef: { userId: 'u', institutionId: 'i' },
      resolveCredentials: async () => ({ apiKey: 'k', apiSecret: 's' }),
      until: UNTIL,
    } as never);
  } finally {
    globalThis.fetch = originalFetch;
  }

  if (starts.length === 0) throw new Error('provider asked about no time window at all');
  return Math.min(...starts);
}

const cases = [
  {
    name: 'binance',
    build: () => new BinanceProvider(passthroughLimiter()),
    institutionCode: 'binance',
    balances: (url: string) =>
      url.includes('/api/v3/account')
        ? new Response(JSON.stringify({ balances: [{ asset: 'BTC', free: '1', locked: '0' }] }), {
            status: 200,
          })
        : null,
  },
  {
    name: 'gate',
    build: () => new GateProvider(passthroughLimiter()),
    institutionCode: 'gate',
    balances: (url: string) =>
      url.includes('/spot/accounts')
        ? new Response(JSON.stringify([{ currency: 'BTC', available: '1', locked: '0' }]), {
            status: 200,
          })
        : null,
  },
  {
    name: 'mexc',
    build: () => new MexcProvider(passthroughLimiter()),
    institutionCode: 'mexc',
    balances: (url: string) =>
      url.includes('/api/v3/account')
        ? new Response(JSON.stringify({ balances: [{ asset: 'BTC', free: '1', locked: '0' }] }), {
            status: 200,
          })
        : null,
  },
] as const;

describe('a since-less run declares how far back it actually reaches', () => {
  for (const testCase of cases) {
    test(`${testCase.name} walks exactly its declared horizon`, async () => {
      const provider = testCase.build();
      const horizon = provider.transactionHistoryHorizonMs;
      expect(horizon).toBeDefined();

      const earliest = await earliestRequestedInstant(
        provider as never,
        testCase.balances as (url: string) => Response | null
      );

      expect(UNTIL.getTime() - earliest).toBe(horizon as number);
    }, 30000);
  }

  // The negative control for the assertion above: a horizon equal to the
  // window is only meaningful if a different window would fail it. Bybit
  // declares thirty days and reaches thirty days, so the same arithmetic on
  // the wrong constant has to disagree.
  test('the same arithmetic rejects a horizon that is not the window', () => {
    const provider = new BinanceProvider(passthroughLimiter());
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(provider.transactionHistoryHorizonMs).not.toBe(thirtyDays);
  });
});

/**
 * The guard that travels. Five providers had this defect and the ticket named
 * three; the two it missed (Airwallex, Wise) were found by reading sources,
 * which is not a thing anyone will remember to do for the sixth.
 *
 * A provider that substitutes its own look-back for a missing `since` is
 * visible in its source — `ctx.since ?? new Date(until.getTime() - WINDOW)` —
 * and so is whether it declares that same `WINDOW` as its horizon. Nothing
 * else reads the two together, so nothing else notices when they part.
 *
 * The readers themselves live in `tests/helpers/provider-sources.ts`, shared
 * with the page-cap guard that reads the same files for a different property
 * (SC-426).
 */

describe('every provider that substitutes a look-back declares it', () => {
  const sources = providerSources().filter((entry) => substitutedWindow(entry.source) !== null);

  // Seven, and the list is the point: bybit and bitget substitute a window too
  // and already declare it, because SC-166 fixed them by hand. The scan
  // reproduces that population without being told it, which is what makes it
  // worth trusting on the eighth provider nobody has looked at yet.
  test('the scan finds every provider that substitutes a window', () => {
    expect(sources.map((s) => s.name).sort()).toEqual([
      'airwallex',
      'binance',
      'bitget',
      'bybit',
      'gate',
      'mexc',
      'wise',
    ]);
  });

  test.each(sources.map((s) => s.name))('%s declares the window it substitutes', (name) => {
    const source = sources.find((s) => s.name === name)?.source ?? '';
    expect(declaredHorizon(source)).toBe(substitutedWindow(source));
  });
});

// Negative controls. Both readers must be able to come back empty, or the
// check above passes on every file including one that declares nothing.
describe('the source scan can fail', () => {
  const substituting = 'const since = ctx.since ?? new Date(until.getTime() - FIVE_YEARS_MS);';

  test('substitutedWindow sees a substitution and ignores a passthrough', () => {
    expect(substitutedWindow(substituting)).toBe('FIVE_YEARS_MS');
    expect(substitutedWindow('const since = ctx.since;')).toBeNull();
  });

  test('declaredHorizon sees a declaration and ignores its absence', () => {
    expect(declaredHorizon('  readonly transactionHistoryHorizonMs = DEFAULT_LOOKBACK_MS;')).toBe(
      'DEFAULT_LOOKBACK_MS'
    );
    expect(declaredHorizon(substituting)).toBeNull();
  });

  test('a provider that substitutes without declaring fails the comparison', () => {
    expect(declaredHorizon(substituting)).not.toBe(substitutedWindow(substituting));
  });
});
