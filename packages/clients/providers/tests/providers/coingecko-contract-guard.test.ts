import { describe, expect, test } from 'bun:test';
import type { TokenMetadata } from '@scani/db/schema';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { makeMockToken } from '../../src/core/testing';
import { CoinGeckoProvider } from '../../src/providers/coingecko';
import {
  contractRefFromMetadata,
  resolveCoingeckoId,
  WELL_KNOWN_COINGECKO_DEPLOYMENTS,
} from '../../src/providers/coingecko/well-known-ids';

/**
 * SC-389. Production held an ERC-20 at `ethereum:0x049b5ed8…` with symbol
 * `USDT` and name `Tether USD`. It was not Tether — the real one is
 * `0xdac17f95…` — but `enrichTokenIdentity` read the symbol, hit the
 * well-known map, and stamped `coingecko.id: 'tether'` onto it without
 * ever looking at the contract address it had been handed. The nightly
 * backfill then wrote 98 genuine Tether quotes onto the impostor.
 *
 * The guard that was supposed to stop this lived in
 * `TokenRepository.findPricingSiblings`, whose docblock states the bucket
 * key is the coingecko id "and NEVER on the symbol". That was true of the
 * function and false of the system: the id had been derived from the
 * symbol one layer up, so the impostor sat in real Tether's bucket
 * anyway. A guard that holds locally and fails in composition is the
 * thing these tests exist to catch, so they assert the WHOLE path — the
 * writer refuses to stamp AND the pricer refuses to quote — rather than
 * only the resolver in isolation.
 */

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

/** The row as production actually held it, before it was deleted. */
const IMPOSTOR_METADATA: TokenMetadata = {
  etherscan: { chainId: 1, contractAddress: '0x049b5ed8d5bceb1065b462e4d9ea97024a2b5ff4' },
};
const REAL_TETHER_METADATA: TokenMetadata = {
  etherscan: { chainId: 1, contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7' },
};

const usdToken = makeMockToken({ id: 'usd', symbol: 'USD', name: 'USD' });

describe('resolveCoingeckoId — an address outranks a symbol', () => {
  test('the well-known symbol map is refused when the contract contradicts it', () => {
    expect(
      resolveCoingeckoId({
        symbol: 'USDT',
        contract: contractRefFromMetadata(IMPOSTOR_METADATA),
      })
    ).toBeNull();
  });

  test('the same symbol on the canonical contract still resolves', () => {
    expect(
      resolveCoingeckoId({
        symbol: 'USDT',
        contract: contractRefFromMetadata(REAL_TETHER_METADATA),
      })
    ).toBe('tether');
  });

  /**
   * The id already written to `providerMetadata` is the one that prices the
   * row on every subsequent run, so checking only the symbol fallback would
   * have left every impostor already in the table pricing as before.
   */
  test('an id already stored in metadata is refused on the same evidence', () => {
    expect(
      resolveCoingeckoId({
        metadataId: 'tether',
        symbol: 'WHATEVER',
        contract: contractRefFromMetadata(IMPOSTOR_METADATA),
      })
    ).toBeNull();
  });

  /**
   * Absence of a deployment is not a contradiction — for an id that had to
   * be earned from `/coins/list`. CoinGecko files WETH on Base under
   * `l2-standard-bridged-weth-base`, which records no deployments in our
   * table, so the row resolves and keeps its DeFiLlama-sourced prices.
   *
   * SC-390 narrowed this to non-well-known ids only; the case below is the
   * other half. The principle itself is unchanged and still load-bearing:
   * SC-389 measured blanket absence-denial and rejected it.
   */
  test('a chain a non-well-known id records no deployment for is left alone', () => {
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

  /**
   * SC-390. The same silence under a WELL-KNOWN id is now a refusal: those
   * 29 ids are reachable from a symbol alone, so they are the ids an
   * impersonator can aim at, and they carry a positive-match bar instead.
   *
   * This is the case that used to read `.toBe('weth')`. It was changed on
   ***REMOVED***
   ***REMOVED***
   * priced it as recently as the hour this was measured. Refusing the
   * CoinGecko leg costs it nothing.
   */
  test('a chain a well-known id records no deployment for is refused', () => {
    expect(
      resolveCoingeckoId({
        symbol: 'WETH',
        contract: contractRefFromMetadata({
          etherscan: {
            chainId: 8453,
            contractAddress: '0x4200000000000000000000000000000000000006',
          },
        }),
      })
    ).toBeNull();
  });

  /**
   * Rows with no contract at all — fiat, equities, exchange catalogue
   * entries, and native assets like BTC and ETH — are the majority of the
   ***REMOVED***
   * have no address to contradict anything and must resolve as before.
   */
  test('a row with no contract address resolves by symbol as before', () => {
    expect(resolveCoingeckoId({ symbol: 'BTC', contract: null })).toBe('bitcoin');
    expect(
      resolveCoingeckoId({
        symbol: 'ETH',
        contract: contractRefFromMetadata({ etherscan: { chainId: 1 } }),
      })
    ).toBe('ethereum');
  });

  /** Solana mints are base58 and case-carrying; lowercasing compares two different mints equal. */
  test('a Solana mint is compared without case folding', () => {
    const canonical = WELL_KNOWN_COINGECKO_DEPLOYMENTS['usd-coin']?.solana;
    expect(canonical).toBeTruthy();
    expect(
      resolveCoingeckoId({
        symbol: 'USDC',
        contract: { platform: 'solana', address: canonical as string },
      })
    ).toBe('usd-coin');
    expect(
      resolveCoingeckoId({
        symbol: 'USDC',
        contract: { platform: 'solana', address: (canonical as string).toLowerCase() },
      })
    ).toBeNull();
  });
});

describe('CoinGeckoProvider — the impostor never acquires an id or a price', () => {
  /**
   * The writer half. `enrichTokenIdentity` is the only code that writes
   * `providerMetadata.coingecko`, and this is the exact call that produced
   * the production row.
   */
  test('enrichTokenIdentity refuses to stamp the well-known id on a contradicting contract', async () => {
    const p = new CoinGeckoProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      throw new Error(`no network expected, got ${url}`);
    }) as unknown as typeof fetch;
    try {
      const delta = await p.enrichTokenIdentity({
        symbol: 'USDT',
        name: 'Tether USD',
        providerMetadata: IMPOSTOR_METADATA,
      });
      expect(delta).toBeNull();

      const real = await p.enrichTokenIdentity({
        symbol: 'USDT',
        name: 'Tether USD',
        providerMetadata: REAL_TETHER_METADATA,
      });
      expect(real?.coingecko?.id).toBe('tether');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * The pricer half, and the reason stripping the metadata was never
   * enough on its own: every CoinGecko entry point re-derives the id from
   * the symbol, so a row with no metadata at all was still priced as
   * Tether. Both halves must hold or the bug survives in the other one.
   */
  test('a metadata-free impostor is not priced by symbol fallback', async () => {
    const p = new CoinGeckoProvider(passthroughLimiter());
    const impostor = makeMockToken({
      id: 'impostor',
      symbol: 'USDT',
      name: 'Tether USD',
      providerMetadata: IMPOSTOR_METADATA,
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

  /**
   * A batch must not fail open. The real Tether row alongside the impostor
   * has to keep pricing, or the guard trades one silent wrong number for a
   * loud missing one.
   */
  test('the real row in the same batch still prices', async () => {
    const p = new CoinGeckoProvider(passthroughLimiter());
    const impostor = makeMockToken({
      id: 'impostor',
      symbol: 'USDT',
      providerMetadata: IMPOSTOR_METADATA,
    });
    const real = makeMockToken({
      id: 'real',
      symbol: 'USDT',
      providerMetadata: REAL_TETHER_METADATA,
    });

    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ tether: { usd: 0.9998 } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const quotes = await p.fetchCurrentPrices([impostor, real], { baseCurrency: usdToken });
      expect(quotes.get('real')?.price).toBe('0.9998');
      expect(quotes.get('impostor')).toBeUndefined();
      expect(capturedUrl).toContain('ids=tether');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * The `/coins/list` path is the same defect with a different source of
   * the id — it matched on symbol and never read the contract either. The
   * list is now requested with `include_platform=true`, so the match's own
   * deployments are checked in the call we already make.
   */
  test('a single /coins/list symbol match is refused when its platforms contradict the contract', async () => {
    const p = new CoinGeckoProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    let listUrl = '';
    globalThis.fetch = (async (url: string) => {
      listUrl = url;
      return new Response(
        JSON.stringify([
          {
            id: 'spx6900',
            symbol: 'spx',
            name: 'SPX6900',
            platforms: { ethereum: '0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c' },
          },
        ]),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    try {
      expect(
        await p.enrichTokenIdentity({
          symbol: 'SPX',
          providerMetadata: {
            etherscan: {
              chainId: 1,
              contractAddress: '0xdd0d0781fd0045ccb8c4f56ab4229a37f8e86e42',
            },
          },
        })
      ).toBeNull();
      expect(listUrl).toContain('include_platform=true');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
