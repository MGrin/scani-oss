import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  __resetJupiterCacheForTests,
  resolveJupiterMint,
} from '../../../src/providers/solana/jupiter';

/**
 * Jupiter retires `lite-api.jup.ag` in favour of keyless `api.jup.ag` at the
 * same paths (developers.jup.ag/docs/portal/migration.md, read 2026-10-05).
 * The body is trimmed from a real `api.jup.ag/tokens/v2/search` response
 * recorded that day; the retired host answers 404 here.
 */
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RECORDED = [{ id: USDC, name: 'USD Coin', symbol: 'USDC', decimals: 6, isVerified: true }];

const originalFetch = globalThis.fetch;
let seen: URL[] = [];

beforeEach(() => {
  __resetJupiterCacheForTests();
  seen = [];
  globalThis.fetch = (async (input: string) => {
    const url = new URL(input);
    seen.push(url);
    if (url.host !== 'api.jup.ag' || url.pathname !== '/tokens/v2/search') {
      return new Response('gone', { status: 404 });
    }
    return new Response(JSON.stringify(RECORDED), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('a mint resolves through api.jup.ag, keyless (SC-1579)', async () => {
  expect(await resolveJupiterMint(USDC)).toEqual({
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    isVerified: true,
  });
  expect(seen.map((u) => u.host)).toEqual(['api.jup.ag']);
  expect(seen[0]?.searchParams.get('query')).toBe(USDC);
});
