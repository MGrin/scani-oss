/**
 * Jupiter token-metadata resolver for Solana SPL mints.
 *
 * Without this, the Solana wallet provider has no way to know that mint
 * `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` is USDC. The previous
 * fallback (`symbol = mint[0:8].toUpperCase()`) created garbage symbols
 * like `EPJFWDD5` that no pricing provider could resolve, leaving 30+
 * production holdings with `coverage_quality='estimated'` forever.
 *
 * Endpoint: `https://lite-api.jup.ag/tokens/v2/search?query=<mint>`
 * — Jupiter's lite tier is free and does not require an API key.
 *
 * Cache: per-process Map, 24 h TTL on hits, 1 h TTL on misses (so a
 * brand-new mint or Jupiter outage doesn't lock us out for a day).
 */

import { fetchWithTimeout } from '../../core/utils/fetch';

const JUPITER_ENDPOINT = 'https://lite-api.jup.ag/tokens/v2/search';
const REQUEST_TIMEOUT_MS = 3000;
const TTL_HIT_MS = 24 * 60 * 60 * 1000;
const TTL_MISS_MS = 60 * 60 * 1000;

export interface JupiterTokenInfo {
  symbol: string;
  name: string;
  decimals: number;
  isVerified: boolean;
}

interface JupiterResponseEntry {
  id?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  isVerified?: boolean;
}

interface CacheEntry {
  value: JupiterTokenInfo | null;
  until: number;
}

const cache = new Map<string, CacheEntry>();

export async function resolveJupiterMint(mint: string): Promise<JupiterTokenInfo | null> {
  const cached = cache.get(mint);
  if (cached && cached.until > Date.now()) return cached.value;

  try {
    const url = `${JUPITER_ENDPOINT}?query=${encodeURIComponent(mint)}`;
    const res = await fetchWithTimeout(url, undefined, REQUEST_TIMEOUT_MS, 0);
    if (!res.ok) {
      cache.set(mint, { value: null, until: Date.now() + TTL_MISS_MS });
      return null;
    }
    const data = (await res.json()) as JupiterResponseEntry[];
    const match = Array.isArray(data) ? data.find((t) => t.id === mint) : null;
    if (!match?.symbol) {
      cache.set(mint, { value: null, until: Date.now() + TTL_MISS_MS });
      return null;
    }
    const info: JupiterTokenInfo = {
      symbol: match.symbol,
      name: match.name ?? match.symbol,
      decimals: typeof match.decimals === 'number' ? match.decimals : 0,
      isVerified: !!match.isVerified,
    };
    cache.set(mint, { value: info, until: Date.now() + TTL_HIT_MS });
    return info;
  } catch {
    cache.set(mint, { value: null, until: Date.now() + TTL_MISS_MS });
    return null;
  }
}

// Test hook only — production callers should use the cached path.
export function __resetJupiterCacheForTests(): void {
  cache.clear();
}
