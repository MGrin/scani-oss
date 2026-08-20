import { describe, expect, test } from 'bun:test';
import type { TokenMetadata } from '@scani/db/schema';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { makeMockToken } from '../../src/core/testing';
import { CoinGeckoProvider } from '../../src/providers/coingecko';
import {
  contractRefFromMetadata,
  resolveCoingeckoId,
} from '../../src/providers/coingecko/well-known-ids';

/**
 * SC-390, the residual SC-389 left open on purpose.
 *
 * SC-389 refuses a CoinGecko id only on a POSITIVE contradiction, because
 * denying on absence would have blanked three genuinely-held production
 * rows. The gap that leaves: an impostor on a chain CoinGecko lists no
 * deployment for produces no contradiction, only silence, and passes.
 *
 * Production held one, live on 2026-08-18:
 *
 *   TRX / "Trx"  base:0x32fa6384cdaa0293f1333988c7700f2f2ab451d1
 *   provider_metadata.coingecko = {"id":"tron"}
 *
 * `tron` records no Base deployment — CoinGecko has no coin at that
 * address on any chain — so nothing contradicted it. `canPrice` returned
 * true, and the next pricing run would have written TRON's price onto it
 * exactly the way the deleted USDT row collected Tether's.
 *
 * The rule: for the 29 ids reachable from a symbol alone, require a
 * positive match against that id's recorded deployments. Those ids are
 * precisely the impersonation targets, so they can carry the higher bar.
 *
 * That row has since been deleted from production, which changes nothing
 * about the code path — the next wallet import can recreate it.
 */

function passthroughLimiter(): OutflowRateLimiter {
  return { execute: async <T>(fn: () => Promise<T>) => fn() } as unknown as OutflowRateLimiter;
}

/** The row as production actually held it. */
const TRX_IMPOSTOR: TokenMetadata = {
  etherscan: { chainId: 8453, contractAddress: '0x32fa6384cdaa0293f1333988c7700f2f2ab451d1' },
  coingecko: { id: 'tron', symbol: 'TRX' },
};

const usdToken = makeMockToken({ id: 'usd', symbol: 'USD', name: 'USD' });

describe('SC-390 — silence is not a licence for a well-known id', () => {
  test('the stored `tron` id is refused on a chain `tron` records no deployment for', () => {
    expect(
      resolveCoingeckoId({
        metadataId: 'tron',
        symbol: 'TRX',
        contract: contractRefFromMetadata(TRX_IMPOSTOR),
      })
    ).toBeNull();
  });

  test('the symbol fallback is refused on the same evidence', () => {
    expect(
      resolveCoingeckoId({
        symbol: 'TRX',
        contract: contractRefFromMetadata({
          etherscan: {
            chainId: 8453,
            contractAddress: '0x32fa6384cdaa0293f1333988c7700f2f2ab451d1',
          },
        }),
      })
    ).toBeNull();
  });

  /**
   * The non-regression that matters most. A real TRON holding is a native
   * asset with no EVM contract, so it has nothing to match against and
   * must resolve exactly as before. A rule that protected the ticker by
   * breaking the asset would be a worse bug than the one it closes.
   */
  test('a genuine TRON holding — native, no contract — still resolves', () => {
    expect(resolveCoingeckoId({ symbol: 'TRX', contract: null })).toBe('tron');
    expect(
      resolveCoingeckoId({
        metadataId: 'tron',
        symbol: 'TRX',
        contract: contractRefFromMetadata({ etherscan: { chainId: 8453 } }),
      })
    ).toBe('tron');
  });

  /**
   * The measured cost of the stricter bar, pinned so it is a decision in
   * the record rather than a surprise. `matic-network` records no platform
   * contracts at all, so a CORRECT id is refused here.
   *
   * Shipped anyway because it was checked end to end against production
   * (2026-08-18, read-only) rather than assumed: DeFiLlama answers for
   * that contract today at confidence 0.99 and covers all 47 days
   * CoinGecko uniquely holds, plus 687 CoinGecko never had. The router's
   * CoinGecko→DeFiLlama fallback fires on the `_no_data` row a refused id
   * produces, and the historical backfill walks past a provider returning
   * zero quotes. Existing rows are retained; only future writes move.
   */
  test('MATIC on Ethereum is refused — the known, measured cost', () => {
    expect(
      resolveCoingeckoId({
        metadataId: 'matic-network',
        symbol: 'MATIC',
        contract: contractRefFromMetadata({
          etherscan: {
            chainId: 1,
            contractAddress: '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0',
          },
        }),
      })
    ).toBeNull();
  });

  /**
   * Positive controls. A rule that denies everything passes every negative
   * test, so the rows that SHOULD keep pricing are asserted alongside —
   * these are the 13 production rows the stricter bar leaves untouched.
   */
  test('well-known ids on their recorded deployments still resolve', () => {
    const cases: Array<[string, number, string, string]> = [
      ['USDT', 1, '0xdac17f958d2ee523a2206206994597c13d831ec7', 'tether'],
      ['USDC', 1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'usd-coin'],
      ['USDC', 8453, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'usd-coin'],
      ['USDC', 137, '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', 'usd-coin'],
      ['STETH', 1, '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', 'staked-ether'],
      ['WETH', 1, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 'weth'],
      ['POL', 137, '0x0000000000000000000000000000000000001010', 'polygon-ecosystem-token'],
    ];
    for (const [symbol, chainId, contractAddress, expected] of cases) {
      expect({
        symbol,
        chainId,
        id: resolveCoingeckoId({
          symbol,
          contract: contractRefFromMetadata({ etherscan: { chainId, contractAddress } }),
        }),
      }).toEqual({ symbol, chainId, id: expected });
    }
  });

  /**
   * An id that had to be earned from `/coins/list` keeps SC-389's looser
   * bar — it is not a symbol-reachable target, so absence is admitted.
   * Without this the rule would blank every bridged deployment CoinGecko
   * files under its own id, which is the outcome SC-389 measured and
   * rejected.
   */
  test('a non-well-known id is still admitted on absence', () => {
    expect(
      resolveCoingeckoId({
        metadataId: 'l2-standard-bridged-weth-base',
        symbol: 'WETH',
        contract: contractRefFromMetadata({
          etherscan: {
            chainId: 8453,
            contractAddress: '0x4200000000000000000000000000000000000006',
          },
        }),
      })
    ).toBe('l2-standard-bridged-weth-base');
  });
});

/**
 * The resolver holding in isolation is not the property that matters —
 * SC-389's whole point was a guard that held locally and failed in
 * composition. Both ends of the path are asserted: the writer refuses to
 * stamp, and the pricer refuses to quote a row already carrying the id.
 */
describe('SC-390 — the impostor neither acquires an id nor a price', () => {
  test('enrichTokenIdentity refuses, and does not fall through to /coins/list', async () => {
    const p = new CoinGeckoProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      throw new Error(`no upstream call expected, got ${url}`);
    }) as unknown as typeof fetch;
    try {
      expect(
        await p.enrichTokenIdentity({
          symbol: 'TRX',
          name: 'Trx',
          providerMetadata: {
            etherscan: {
              chainId: 8453,
              contractAddress: '0x32fa6384cdaa0293f1333988c7700f2f2ab451d1',
            },
          },
        })
      ).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a row already carrying the poisoned id is not priced by any entry point', async () => {
    const p = new CoinGeckoProvider(passthroughLimiter());
    const impostor = makeMockToken({
      id: 'trx-impostor',
      symbol: 'TRX',
      name: 'Trx',
      providerMetadata: TRX_IMPOSTOR,
    });

    expect(p.canPrice(impostor)).toBe(false);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      throw new Error(`no upstream call expected, got ${url}`);
    }) as unknown as typeof fetch;
    try {
      expect((await p.fetchCurrentPrices([impostor], { baseCurrency: usdToken })).size).toBe(0);
      expect(
        await p.fetchHistoricalPrice(impostor, new Date('2026-05-01'), { baseCurrency: usdToken })
      ).toBeNull();
      expect(
        (
          await p.fetchHistoricalRange(impostor, new Date('2026-04-01'), new Date('2026-05-01'), {
            baseCurrency: usdToken,
          })
        ).length
      ).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /** A batch must not fail open: a real TRON row alongside it still prices. */
  test('a genuine TRON row in the same batch still prices', async () => {
    const p = new CoinGeckoProvider(passthroughLimiter());
    const impostor = makeMockToken({
      id: 'impostor',
      symbol: 'TRX',
      providerMetadata: TRX_IMPOSTOR,
    });
    const real = makeMockToken({
      id: 'real',
      symbol: 'TRX',
      providerMetadata: { coingecko: { id: 'tron', symbol: 'TRX' } },
    });

    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ tron: { usd: 0.31 } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const quotes = await p.fetchCurrentPrices([impostor, real], { baseCurrency: usdToken });
      expect(quotes.get('real')?.price).toBe('0.31');
      expect(quotes.get('impostor')).toBeUndefined();
      expect(capturedUrl).toContain('ids=tron');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
