/**
 * `DeFiLlamaProvider` — primary fallback for crypto prices when
 * CoinGecko doesn't have the token.
 *
 * Capabilities:
 *  - `current-price`: `/prices/current/{chain}:{address}` per token
 *    (no batch endpoint).
 *  - `historical-price`: `/prices/historical/{unix}/{chain}:{address}`
 *    — primary backfill source for crypto, no date cap.
 *  - `token-identity`: derives the DeFiLlama coin spec
 *    (`"chain:address"` for EVM, `"coingecko:id"` as a fallback)
 *    from the token's etherscan + coingecko metadata namespaces.
 *
 * Pre-refactor location:
 * `packages/pricing-providers/src/providers/defillama.ts`. The
 * shape change is the same as CoinGecko's — `Token.providerMetadata`
 * with namespaced keys replaces the flat `providerTokenId` string.
 *
 * Confidence threshold: DeFiLlama returns a 0-1 confidence score per
 * token. We reject anything below 0.8 because low-confidence prices
 * usually belong to freshly-deployed scam contracts; the orchestrator
 * falls through to the next provider tier.
 */

import type { NewToken, Token, TokenMetadata } from '@scani/db/schema';
import { type CustomLogger, createComponentLogger } from '@scani/logging';
import { createOutflowLimiter, type OutflowRateLimiter } from '@scani/rate-limiter';
import type { ProviderFactory } from '../../core/boot';
import type {
  Capability,
  HistoricalPriceProvider,
  TokenIdentityProvider,
} from '../../core/capabilities';
import type { PriceQuote, ProviderContext } from '../../core/types';
import { fetchWithTimeout } from '../../core/utils/fetch';
import type { CurrencyConverter } from '../coingecko';
import { CHAIN_ID_TO_DEFILLAMA, DEFILLAMA_MIN_CONFIDENCE } from './chains';

interface DeFiLlamaCurrentResponse {
  coins: Record<
    string,
    {
      decimals?: number;
      symbol?: string;
      price?: number;
      timestamp?: number;
      confidence?: number;
    }
  >;
}

interface DeFiLlamaHistoricalResponse {
  coins: Record<
    string,
    {
      decimals?: number;
      symbol?: string;
      price?: number;
      timestamp?: number;
    }
  >;
}

export class DeFiLlamaProvider implements HistoricalPriceProvider, TokenIdentityProvider {
  readonly providerKey = 'defillama';
  readonly capabilities: readonly Capability[] = [
    'current-price',
    'historical-price',
    'token-identity',
  ];

  private readonly logger: CustomLogger;

  constructor(
    private readonly limiter: OutflowRateLimiter,
    private readonly opts: { converter?: CurrencyConverter | undefined } = {}
  ) {
    this.logger = createComponentLogger('provider:defillama');
  }

  // ============================================================
  // CurrentPriceProvider + HistoricalPriceProvider
  // ============================================================

  canPrice(t: Token): boolean {
    return Boolean(this.coinKey(t));
  }

  async fetchCurrentPrice(t: Token, ctx: ProviderContext): Promise<PriceQuote | null> {
    const key = this.coinKey(t);
    if (!key) return null;

    // `searchWidth=4h` widens the lookup window from "right now" to "any
    // price seen in the last 4 hours". Without it DeFiLlama returns
    // `{coins:{}}` for any token whose pools haven't ticked in the last
    // few minutes — even popular L2 tokens with daily volume in the
    // thousands. 4h matches the threshold the rest of the project's
    // upstream (DeFiLlama recommended) uses; the dataset is updated
    // ~every 5min so tokens with real liquidity always come back.
    const url = `https://coins.llama.fi/prices/current/${key}?searchWidth=4h`;
    try {
      const response = await this.limiter.execute(async () =>
        fetchWithTimeout(url, { headers: { 'Content-Type': 'application/json' } })
      );
      if (!response.ok) return null;
      const data = (await response.json()) as DeFiLlamaCurrentResponse;
      const coin = data.coins?.[key];
      if (!coin || coin.price == null || coin.price <= 0) return null;
      if ((coin.confidence ?? 0) < DEFILLAMA_MIN_CONFIDENCE) return null;

      return this.toQuote(t, ctx, String(coin.price), ctx.timestamp ?? new Date(), 'defillama');
    } catch (err) {
      this.logger.debug({ err, key }, 'DeFiLlama current request failed');
      return null;
    }
  }

  async fetchHistoricalPrice(t: Token, at: Date, ctx: ProviderContext): Promise<PriceQuote | null> {
    const key = this.coinKey(t);
    if (!key) return null;

    const unix = Math.floor(at.getTime() / 1000);
    // Same `searchWidth` rationale as `fetchCurrentPrice`. For
    // historical we widen to 24h since the backfill snapshots are
    // daily anyway — accepting a price within a day of the requested
    // instant is fine.
    const url = `https://coins.llama.fi/prices/historical/${unix}/${key}?searchWidth=24h`;
    try {
      const response = await this.limiter.execute(async () =>
        fetchWithTimeout(url, { headers: { 'Content-Type': 'application/json' } })
      );
      if (!response.ok) return null;
      const data = (await response.json()) as DeFiLlamaHistoricalResponse;
      const coin = data.coins?.[key];
      if (!coin || coin.price == null || coin.price <= 0) return null;
      const ts = coin.timestamp ? new Date(coin.timestamp * 1000) : at;
      return this.toQuote(t, ctx, String(coin.price), ts, 'defillama_historical');
    } catch (err) {
      this.logger.debug({ err, key, at }, 'DeFiLlama historical request failed');
      return null;
    }
  }

  /**
   * Range fetch via DeFiLlama's `/chart/{key}` endpoint. Returns up to
   * `span` daily candles in a single HTTP call — the difference
   * between this and looping `fetchHistoricalPrice` per day is the
   * difference between 1 call and 365 calls per token. Without this
   * method the backfill orchestrator fans out per-day calls throttled
   * at 5/sec, which makes a 365-day backfill for 8 tokens take ~10 min;
   * with the range method it finishes in seconds.
   */
  async fetchHistoricalRange(
    t: Token,
    from: Date,
    to: Date,
    ctx: ProviderContext
  ): Promise<PriceQuote[]> {
    const key = this.coinKey(t);
    if (!key) return [];
    if (to.getTime() < from.getTime()) return [];

    // Span is days between from and to (inclusive); cap at 1825 to
    // match the longest backfill window we use elsewhere. `period=1d`
    // gives daily candles, `searchWidth=24h` widens the per-bar
    // tolerance so DeFiLlama returns a quote for any day within 24h
    // of a real datapoint.
    const days =
      Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000))) + 1;
    const span = Math.min(days, 1825);
    const startSec = Math.floor(from.getTime() / 1000);
    const url = `https://coins.llama.fi/chart/${encodeURIComponent(key)}?start=${startSec}&period=1d&span=${span}&searchWidth=24h`;

    interface ChartResponse {
      coins: Record<
        string,
        {
          symbol?: string;
          confidence?: number;
          decimals?: number;
          prices?: Array<{ timestamp: number; price: number }>;
        }
      >;
    }

    try {
      const response = await this.limiter.execute(async () =>
        fetchWithTimeout(url, { headers: { 'Content-Type': 'application/json' } })
      );
      if (!response.ok) return [];
      const data = (await response.json()) as ChartResponse;
      const coin = data.coins?.[key];
      if (!coin || !Array.isArray(coin.prices)) return [];
      if ((coin.confidence ?? 0) < DEFILLAMA_MIN_CONFIDENCE) return [];

      const baseUpper = ctx.baseCurrency.symbol.toUpperCase();
      const out: PriceQuote[] = [];
      for (const bar of coin.prices) {
        if (typeof bar.price !== 'number' || bar.price <= 0) continue;
        if (typeof bar.timestamp !== 'number') continue;
        const at = new Date(bar.timestamp * 1000);
        // USD path is direct; non-USD bases re-use the same converter
        // pattern as the per-day method via toQuote.
        const quote = await this.toQuote(t, ctx, String(bar.price), at, 'defillama_historical');
        if (quote) out.push(quote);
      }
      this.logger.debug(
        { key, span, returned: out.length, base: baseUpper },
        'DeFiLlama range fetched'
      );
      return out;
    } catch (err) {
      this.logger.debug({ err, key, from, to }, 'DeFiLlama range request failed');
      return [];
    }
  }

  // ============================================================
  // TokenIdentityProvider
  // ============================================================

  async enrichTokenIdentity(
    partial: Partial<NewToken>,
    opts?: { force?: boolean }
  ): Promise<Partial<TokenMetadata> | null> {
    const meta = partial.providerMetadata as TokenMetadata | undefined;
    if (meta?.defillama && !opts?.force) return null;

    // Prefer EVM chain:contract — most precise identity.
    const eth = meta?.etherscan;
    if (eth?.chainId && eth.contractAddress) {
      const chainName = CHAIN_ID_TO_DEFILLAMA[eth.chainId];
      if (chainName) {
        return {
          defillama: { coin: `${chainName}:${eth.contractAddress.toLowerCase()}` },
        };
      }
    }

    // Solana SPL — DeFiLlama indexes by mint under the `solana:` chain.
    const sol = meta?.solana?.mint;
    if (sol) {
      return { defillama: { coin: `solana:${sol}` } };
    }

    // Fall back to coingecko id (DeFiLlama accepts `coingecko:bitcoin`
    // syntax for non-EVM majors).
    const cg = meta?.coingecko?.id;
    if (cg) {
      return { defillama: { coin: `coingecko:${cg}` } };
    }

    return null;
  }

  // ============================================================
  // Internals
  // ============================================================

  /**
   * Build the DeFiLlama coin key from a Token. Falls back through
   * the same priority order as `enrichTokenIdentity` so a freshly-
   * loaded Token without an explicit `defillama.coin` can still be
   * priced.
   */
  private coinKey(t: Token): string | null {
    const meta = t.providerMetadata as TokenMetadata | null;
    if (meta?.defillama?.coin) return meta.defillama.coin;
    const eth = meta?.etherscan;
    if (eth?.chainId && eth.contractAddress) {
      const chainName = CHAIN_ID_TO_DEFILLAMA[eth.chainId];
      if (chainName) return `${chainName}:${eth.contractAddress.toLowerCase()}`;
    }
    // Solana SPL tokens — DeFiLlama indexes them under `solana:<mint>`
    // and provides both current and historical prices, including for
    // long-tail SPL tokens that CoinGecko doesn't track. Without this
    // branch every Solana wallet shows up as a flat dashed line on
    // the chart because no provider can price the SPL holdings.
    const sol = meta?.solana?.mint;
    if (sol) return `solana:${sol}`;
    const cg = meta?.coingecko?.id;
    if (cg) return `coingecko:${cg}`;
    return null;
  }

  /**
   * Build a `PriceQuote` and apply USD→base conversion if the user's
   * base currency isn't USD. Same converter contract as CoinGecko's;
   * cloud mode never reaches this branch (the data-provider does the
   * conversion before serializing the response).
   */
  private async toQuote(
    t: Token,
    ctx: ProviderContext,
    usdPrice: string,
    timestamp: Date,
    sourceTag: string
  ): Promise<PriceQuote | null> {
    const baseUpper = ctx.baseCurrency.symbol.toUpperCase();
    if (baseUpper === 'USD') {
      return {
        tokenId: t.id,
        baseTokenId: ctx.baseCurrency.id,
        price: usdPrice,
        timestamp,
        source: sourceTag,
      };
    }
    const converter = this.opts.converter;
    if (!converter) return null;
    const converted = await converter.convert(usdPrice, 'USD', baseUpper, timestamp);
    if (converted === null || converted === '0') return null;
    return {
      tokenId: t.id,
      baseTokenId: ctx.baseCurrency.id,
      price: converted,
      timestamp,
      source: `${sourceTag}_converted`,
    };
  }
}

export const defillamaFactory: ProviderFactory = async (deps) => {
  // DeFiLlama free tier: 5 calls/sec.
  const limiter = createOutflowLimiter({
    maxRequests: 5,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'defillama',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'defillama',
    limiter,
    registeredFrom: 'providers/defillama',
    description: 'DeFiLlama: 5 req / 1s',
  });
  return new DeFiLlamaProvider(registered);
};

export { CHAIN_ID_TO_DEFILLAMA, DEFILLAMA_MIN_CONFIDENCE } from './chains';
