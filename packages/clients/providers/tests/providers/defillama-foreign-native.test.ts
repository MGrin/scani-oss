/**
 * SC-403 — DeFiLlama must price a Solana token by its MINT, never by an EVM
 * contract that happens to sit on the same row.
 *
 * `coinKey` used to consult `defillama.coin` and then `etherscan` before it
 * ever looked at `solana.mint`, so the mint branch was unreachable for any row
 * carrying both. Production BONK and TRUMP each carried a Base contract for a
 * DIFFERENT token of the same ticker, and DeFiLlama has no data for either of
 * those addresses — so the key that went upstream could never return a price
 * and the holding would have shown as unpriceable the moment someone held one.
 */
import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { makeMockToken } from '../../src/core/testing';
import { DeFiLlamaProvider } from '../../src/providers/defillama';

function passthroughLimiter(): OutflowRateLimiter {
  return { execute: async <T>(fn: () => Promise<T>) => fn() } as unknown as OutflowRateLimiter;
}

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const IMPOSTOR = '0xf2b2c2a4e4eae02ba07decece8d831b11bd7a350';
const usdToken = makeMockToken({ id: 'usd', symbol: 'USD', name: 'USD' });

/** The row exactly as production held it. */
const contaminated = makeMockToken({
  id: 'bonk',
  symbol: 'BONK',
  providerMetadata: {
    solana: { mint: MINT },
    defillama: { coin: `base:${IMPOSTOR}` },
    etherscan: { chainId: 8453, contractAddress: IMPOSTOR },
  },
});

async function captureRequestedUrl(
  run: (p: DeFiLlamaProvider) => Promise<unknown>
): Promise<string> {
  const p = new DeFiLlamaProvider(passthroughLimiter());
  const originalFetch = globalThis.fetch;
  let requested = '';
  globalThis.fetch = (async (url: string) => {
    requested = String(url);
    return new Response(JSON.stringify({ coins: {} }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await run(p);
  } finally {
    globalThis.fetch = originalFetch;
  }
  // `/chart` percent-encodes the coin key while the spot endpoints do not,
  // so decode before asserting rather than writing the assertion twice.
  return decodeURIComponent(requested);
}

describe('DeFiLlamaProvider — foreign-native identity outranks an EVM contract', () => {
  test('fetchCurrentPrice queries the mint, not the stored EVM coin key', async () => {
    const url = await captureRequestedUrl((p) =>
      p.fetchCurrentPrice(contaminated, { baseCurrency: usdToken })
    );
    expect(url).toContain(`solana:${MINT}`);
    expect(url).not.toContain(IMPOSTOR);
  });

  test('fetchHistoricalPrice queries the mint', async () => {
    const url = await captureRequestedUrl((p) =>
      p.fetchHistoricalPrice(contaminated, new Date('2025-08-01T00:00:00Z'), {
        baseCurrency: usdToken,
      })
    );
    expect(url).toContain(`solana:${MINT}`);
    expect(url).not.toContain(IMPOSTOR);
  });

  test('fetchHistoricalRange queries the mint', async () => {
    const url = await captureRequestedUrl((p) =>
      p.fetchHistoricalRange(
        contaminated,
        new Date('2025-08-01T00:00:00Z'),
        new Date('2025-08-05T00:00:00Z'),
        { baseCurrency: usdToken }
      )
    );
    expect(url).toContain(`solana:${MINT}`);
    expect(url).not.toContain(IMPOSTOR);
  });

  test('a stored coin key that agrees with the mint is still honoured', async () => {
    const clean = makeMockToken({
      id: 'jup',
      symbol: 'JUP',
      providerMetadata: {
        solana: { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
        defillama: { coin: 'solana:JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
      },
    });
    const url = await captureRequestedUrl((p) =>
      p.fetchCurrentPrice(clean, { baseCurrency: usdToken })
    );
    expect(url).toContain('solana:JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');
  });

  test('a pure EVM row is untouched by the rule', async () => {
    const evm = makeMockToken({
      id: 'usdc',
      symbol: 'USDC',
      providerMetadata: { etherscan: { chainId: 1, contractAddress: '0xA0b8' } },
    });
    const url = await captureRequestedUrl((p) =>
      p.fetchCurrentPrice(evm, { baseCurrency: usdToken })
    );
    expect(url).toContain('ethereum:0xa0b8');
  });
});

describe('DeFiLlamaProvider.enrichTokenIdentity — never derives an EVM coin key for a mint row', () => {
  test('derives the mint key even when an EVM contract is present', async () => {
    const p = new DeFiLlamaProvider(passthroughLimiter());
    const delta = await p.enrichTokenIdentity({
      symbol: 'BONK',
      providerMetadata: {
        solana: { mint: MINT },
        etherscan: { chainId: 8453, contractAddress: IMPOSTOR },
      },
    });
    expect(delta).toEqual({ defillama: { coin: `solana:${MINT}` } });
  });

  test('still derives the contract key for a row with no foreign-native identity', async () => {
    const p = new DeFiLlamaProvider(passthroughLimiter());
    const delta = await p.enrichTokenIdentity({
      symbol: 'USDC',
      providerMetadata: { etherscan: { chainId: 8453, contractAddress: '0xabc' } },
    });
    expect(delta).toEqual({ defillama: { coin: 'base:0xabc' } });
  });
});
