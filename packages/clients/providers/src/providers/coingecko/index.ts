/**
 * `CoinGeckoProvider` — the primary crypto current-price provider.
 *
 * Capabilities:
 *  - `current-price`: `/simple/price?ids=...&vs_currencies=...`. Batch
 *    endpoint accepts hundreds of ids per call; the orchestrator's
 *    `fetchCurrentPrices` hot path uses this when it can.
 *  - `historical-price`: `/coins/{id}/history?date=DD-MM-YYYY` for
 *    point-in-time daily closes. CoinGecko returns the close at 00:00
 *    UTC for the given calendar day.
 *  - `token-identity`: probes `/coins/list` (cached at process scope)
 *    when we have a symbol but no `providerMetadata.coingecko.id`.
 *
 * Pre-refactor location:
 * `packages/pricing-providers/src/providers/coingecko.ts`. The biggest
 * shape change is the move from `TokenWithProvider` (which carried
 * `providerTokenId`) to the Drizzle-typed `Token` row whose
 * `providerMetadata.coingecko.id` carries the same data with
 * provider-namespacing. Behaviour is otherwise unchanged.
 *
 * The provider talks to the API using the user's base currency when
 * CoinGecko supports it (USD/EUR/GBP/CHF/JPY and ~40 others); falls
 * through to USD with an injected `CurrencyConverter` only for
 * exotic bases. Both paths emit the same `PriceQuote` shape so the
 * orchestrator doesn't have to know which path was taken.
 */

import type { NewToken, Token, TokenMetadata } from '@scani/db/schema';
import { type CustomLogger, createComponentLogger } from '@scani/logging';
import { createOutflowLimiter, type OutflowRateLimiter } from '@scani/rate-limiter';
import type { ProviderFactory } from '../../core/boot';
import type {
  Capability,
  HistoricalPriceProvider,
  TokenIdentityProvider,
  TokenSearchResult,
} from '../../core/capabilities';
import type { PriceQuote, ProviderContext } from '../../core/types';
import { fetchWithTimeout } from '../../core/utils/fetch';
import { resolveCoingeckoId } from './well-known-ids';

const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';
const COINGECKO_PRO_BASE_URL = 'https://pro-api.coingecko.com/api/v3';

// ISO-4217 fiat codes the federated identity flow must NOT enrich
// with a CoinGecko id. CG uses these as quote currencies, not coins;
// the public list nevertheless contains scam tokens claiming the
// same tickers (e.g. `unstable-states-dollar` for symbol "usd"). Fiat
// rows go through Frankfurter for FX rates, not crypto pricers.
const FIAT_SYMBOLS = new Set([
  'usd',
  'eur',
  'gbp',
  'jpy',
  'chf',
  'cad',
  'aud',
  'nzd',
  'cny',
  'hkd',
  'sgd',
  'sek',
  'nok',
  'dkk',
  'krw',
  'inr',
  'thb',
  'mxn',
  'brl',
  'zar',
  'try',
  'rub',
  'pln',
  'czk',
  'huf',
  'ils',
  'aed',
  'sar',
  'qar',
  'kwd',
  'bhd',
  'omr',
  'idr',
  'myr',
  'php',
  'vnd',
  'twd',
  'ars',
  'clp',
  'cop',
  'pen',
  'uyu',
]);
/**
 * Practical URL-length cap. Long ids ("staked-ether", "the-open-network")
 * inflate the query string fast; 250 keeps the URL well under any sane
 * proxy/server limit even with maximal ids.
 */
const MAX_IDS_PER_REQUEST = 250;

interface SimplePriceResponse {
  [coinId: string]: {
    [currency: string]: number | undefined;
  };
}

interface HistoryResponse {
  market_data?: {
    current_price?: Record<string, number>;
  };
}

interface CoinListEntry {
  id: string;
  symbol: string;
  name: string;
}

/**
 * Optional dependency for converting USD→user-base when CoinGecko
 * doesn't natively support the user's base. Direct mode wires this
 * to a domain-side `CurrencyConverter`; cloud mode calls the
 * data-provider through the cloud client and never needs this path.
 */
export interface CurrencyConverter {
  convert(price: string, fromSymbol: string, toSymbol: string, at?: Date): Promise<string>;
}

export class CoinGeckoProvider implements HistoricalPriceProvider, TokenIdentityProvider {
  readonly providerKey = 'coingecko';
  readonly capabilities: readonly Capability[] = [
    'current-price',
    'historical-price',
    'token-identity',
  ];

  private readonly logger: CustomLogger;
  private coinListCache: CoinListEntry[] | null = null;

  constructor(
    private readonly limiter: OutflowRateLimiter,
    private readonly opts: {
      apiKey?: string | undefined;
      converter?: CurrencyConverter | undefined;
    } = {}
  ) {
    this.logger = createComponentLogger('provider:coingecko');
  }

  // ============================================================
  // CurrentPriceProvider + HistoricalPriceProvider
  // ============================================================

  canPrice(t: Token): boolean {
    const metaId = (t.providerMetadata as TokenMetadata | null)?.coingecko?.id;
    return Boolean(resolveCoingeckoId({ metadataId: metaId, symbol: t.symbol }));
  }

  async fetchCurrentPrice(t: Token, ctx: ProviderContext): Promise<PriceQuote | null> {
    const map = await this.fetchCurrentPrices([t], ctx);
    return map.get(t.id) ?? null;
  }

  async fetchCurrentPrices(
    tokens: Token[],
    ctx: ProviderContext
  ): Promise<Map<string, PriceQuote>> {
    if (tokens.length === 0) return new Map();

    const filtered = tokens.filter((t) => this.canPrice(t));
    if (filtered.length === 0) return new Map();

    // Process in chunks to respect URL-length budget.
    const out = new Map<string, PriceQuote>();
    for (let i = 0; i < filtered.length; i += MAX_IDS_PER_REQUEST) {
      const chunk = filtered.slice(i, i + MAX_IDS_PER_REQUEST);
      const partial = await this.fetchCurrentPricesChunk(chunk, ctx);
      for (const [k, v] of partial) out.set(k, v);
    }
    return out;
  }

  private async fetchCurrentPricesChunk(
    tokens: Token[],
    ctx: ProviderContext
  ): Promise<Map<string, PriceQuote>> {
    const baseLower = ctx.baseCurrency.symbol.toLowerCase();
    const idMap = new Map<string, Token>();
    for (const t of tokens) {
      const meta = (t.providerMetadata as TokenMetadata | null)?.coingecko?.id;
      const id = resolveCoingeckoId({ metadataId: meta, symbol: t.symbol });
      if (id) idMap.set(id, t);
    }
    if (idMap.size === 0) return new Map();

    const ids = [...idMap.keys()].join(',');
    const out = new Map<string, PriceQuote>();

    // Try the user's base currency first. CoinGecko's vs_currencies
    // covers ~40 fiats + crypto; the request silently returns no
    // values for unsupported currencies — we detect that and retry
    // in USD with conversion.
    const primary = await this.requestSimplePrice(ids, baseLower);
    if (!primary) return out;

    const hasAny = tokens.some((t) => {
      const meta = (t.providerMetadata as TokenMetadata | null)?.coingecko?.id;
      const id = resolveCoingeckoId({ metadataId: meta, symbol: t.symbol });
      if (!id) return false;
      const v = primary[id]?.[baseLower];
      return typeof v === 'number' && v > 0;
    });

    if (hasAny || baseLower === 'usd') {
      // Direct path — emit quotes in user's base.
      for (const [id, token] of idMap) {
        const v = primary[id]?.[baseLower];
        if (typeof v !== 'number' || v <= 0) continue;
        out.set(token.id, {
          tokenId: token.id,
          baseTokenId: ctx.baseCurrency.id,
          price: String(v),
          timestamp: ctx.timestamp ?? new Date(),
          source: 'coingecko',
        });
      }
      return out;
    }

    // Fallback: request USD and convert. Requires a `converter` dep —
    // direct mode injects one; cloud mode never reaches this branch.
    const converter = this.opts.converter;
    if (!converter) {
      this.logger.warn(
        { baseLower },
        'CoinGecko returned no rows for base currency and no converter is configured; giving up'
      );
      return out;
    }

    const usdResp = await this.requestSimplePrice(ids, 'usd');
    if (!usdResp) return out;
    const baseUpper = ctx.baseCurrency.symbol.toUpperCase();
    for (const [id, token] of idMap) {
      const v = usdResp[id]?.usd;
      if (typeof v !== 'number' || v <= 0) continue;
      const converted = await converter.convert(String(v), 'USD', baseUpper, ctx.timestamp);
      if (converted === '0') continue;
      out.set(token.id, {
        tokenId: token.id,
        baseTokenId: ctx.baseCurrency.id,
        price: converted,
        timestamp: ctx.timestamp ?? new Date(),
        source: 'coingecko_usd_converted',
      });
    }
    return out;
  }

  /**
   * Range fetch via CoinGecko's `/coins/{id}/market_chart/range` endpoint —
   * returns daily price points for the entire period in a single response.
   * Collapses 365 per-day calls into one, which on a free-tier API key
   * (~10-30 req/min) is the difference between ~15 minutes and ~5 seconds
   * for a 1Y BTC backfill.
   *
   * Falls back to USD-converted prices when the user's base currency
   * isn't directly quoted by CoinGecko, mirroring the per-day path.
   */
  async fetchHistoricalRange(
    t: Token,
    from: Date,
    to: Date,
    ctx: ProviderContext
  ): Promise<PriceQuote[]> {
    const meta = (t.providerMetadata as TokenMetadata | null)?.coingecko?.id;
    const id = resolveCoingeckoId({ metadataId: meta, symbol: t.symbol });
    if (!id) return [];
    if (to.getTime() < from.getTime()) return [];

    const baseLower = ctx.baseCurrency.symbol.toLowerCase();
    const baseUpper = ctx.baseCurrency.symbol.toUpperCase();
    const fromSec = Math.floor(from.getTime() / 1000);
    const toSec = Math.floor(to.getTime() / 1000);

    // Try the user's base currency directly first; CoinGecko quotes
    // most majors (USD, EUR, GBP, JPY, …). Falls back to USD-converted
    // when the requested base isn't supported (rare for held assets).
    const direct = await this.fetchMarketChartRange(id, baseLower, fromSec, toSec);
    if (direct && direct.length > 0) {
      return direct.map((bar) => ({
        tokenId: t.id,
        baseTokenId: ctx.baseCurrency.id,
        price: String(bar.price),
        timestamp: new Date(bar.timeMs),
        source: 'coingecko_historical',
      }));
    }

    // USD fallback + per-day FX conversion. Each conversion goes
    // through the BalanceAtTimeService's price graph, so it's free
    // when the FX rate is already cached and a single SQL hit otherwise.
    if (baseLower === 'usd') return [];
    const usdSeries = await this.fetchMarketChartRange(id, 'usd', fromSec, toSec);
    if (!usdSeries || usdSeries.length === 0) return [];
    const converter = this.opts.converter;
    if (!converter) return [];
    const out: PriceQuote[] = [];
    for (const bar of usdSeries) {
      const at = new Date(bar.timeMs);
      const converted = await converter.convert(String(bar.price), 'USD', baseUpper, at);
      if (converted === '0') continue;
      out.push({
        tokenId: t.id,
        baseTokenId: ctx.baseCurrency.id,
        price: converted,
        timestamp: at,
        source: 'coingecko_historical_usd_converted',
      });
    }
    return out;
  }

  // Hits /coins/{id}/market_chart/range and normalizes to {timeMs, price}
  // bars. CoinGecko returns `prices: [[unixMs, price], ...]` — daily for
  // ranges > 90 days, hourly for ≤ 90, 5-min for ≤ 1 day. We only ever
  // call this from the backfill orchestrator with multi-week ranges, so
  // we get daily grain in practice.
  private async fetchMarketChartRange(
    id: string,
    vsCurrencyLower: string,
    fromSec: number,
    toSec: number
  ): Promise<Array<{ timeMs: number; price: number }> | null> {
    const url = `${this.baseUrl()}/coins/${encodeURIComponent(id)}/market_chart/range?vs_currency=${vsCurrencyLower}&from=${fromSec}&to=${toSec}`;
    try {
      const response = await this.limiter.execute(async () =>
        fetchWithTimeout(url, { headers: this.headers() })
      );
      if (!response.ok) {
        this.logger.warn(
          { status: response.status, id, vsCurrencyLower },
          'CoinGecko /market_chart/range non-OK'
        );
        return null;
      }
      const data = (await response.json()) as { prices?: Array<[number, number]> };
      if (!Array.isArray(data.prices)) return null;
      const out: Array<{ timeMs: number; price: number }> = [];
      for (const tuple of data.prices) {
        if (!Array.isArray(tuple) || tuple.length < 2) continue;
        const [ts, price] = tuple;
        if (typeof ts !== 'number' || typeof price !== 'number' || !Number.isFinite(price)) {
          continue;
        }
        out.push({ timeMs: ts, price });
      }
      return out;
    } catch (err) {
      this.logger.debug({ err, id, vsCurrencyLower }, 'CoinGecko range fetch failed');
      return null;
    }
  }

  async fetchHistoricalPrice(t: Token, at: Date, ctx: ProviderContext): Promise<PriceQuote | null> {
    const meta = (t.providerMetadata as TokenMetadata | null)?.coingecko?.id;
    const id = resolveCoingeckoId({ metadataId: meta, symbol: t.symbol });
    if (!id) return null;

    // CoinGecko's /coins/{id}/history wants DD-MM-YYYY.
    const yyyy = at.getUTCFullYear();
    const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(at.getUTCDate()).padStart(2, '0');
    const dateStr = `${dd}-${mm}-${yyyy}`;

    const url = `${this.baseUrl()}/coins/${encodeURIComponent(id)}/history?date=${dateStr}&localization=false`;
    try {
      const response = await this.limiter.execute(async () =>
        fetchWithTimeout(url, { headers: this.headers() })
      );
      if (!response.ok) return null;
      const data = (await response.json()) as HistoryResponse;
      const baseLower = ctx.baseCurrency.symbol.toLowerCase();
      const direct = data.market_data?.current_price?.[baseLower];
      if (typeof direct === 'number' && direct > 0) {
        return {
          tokenId: t.id,
          baseTokenId: ctx.baseCurrency.id,
          price: String(direct),
          timestamp: at,
          source: 'coingecko_historical',
        };
      }
      const usd = data.market_data?.current_price?.usd;
      if (typeof usd !== 'number' || usd <= 0) return null;
      const converter = this.opts.converter;
      if (!converter) return null;
      const baseUpper = ctx.baseCurrency.symbol.toUpperCase();
      const converted = await converter.convert(String(usd), 'USD', baseUpper, at);
      if (converted === '0') return null;
      return {
        tokenId: t.id,
        baseTokenId: ctx.baseCurrency.id,
        price: converted,
        timestamp: at,
        source: 'coingecko_historical_usd_converted',
      };
    } catch (err) {
      this.logger.debug({ err, id, at }, 'CoinGecko historical lookup failed');
      return null;
    }
  }

  // ============================================================
  // TokenIdentityProvider
  // ============================================================

  /**
   * Probe CoinGecko's `/coins/list` to find the id for an unknown
   * token. Idempotent — skips when the metadata key is already
   * present unless `force` is true.
   */
  async enrichTokenIdentity(
    partial: Partial<NewToken>,
    opts?: { force?: boolean }
  ): Promise<Partial<TokenMetadata> | null> {
    const existing = (partial.providerMetadata as TokenMetadata | undefined)?.coingecko?.id;
    if (existing && !opts?.force) return null;
    const symbol = partial.symbol?.toLowerCase();
    if (!symbol) return null;

    // Fiat ISO codes: never run CG list-search for these. CoinGecko
    // doesn't index real fiat (it uses USD/EUR/GBP/JPY/… as quote
    // *currencies*, not coins) but its public list happens to contain
    // scam tokens that pretend to be fiat (`unstable-states-dollar`
    // claims symbol `usd`, etc.). Without this gate, a Kraken USD
    // holding silently gets `coingecko.id: 'unstable-states-dollar'`
    // glued onto its metadata and the dashboard prices it accordingly.
    // Fiat tokens are priced via Frankfurter (FX provider); they
    // should never go through CoinGecko at all.
    if (FIAT_SYMBOLS.has(symbol)) return null;

    const wellKnown = resolveCoingeckoId({ metadataId: undefined, symbol });
    if (wellKnown) {
      return { coingecko: { id: wellKnown, symbol: symbol.toUpperCase() } };
    }

    const list = await this.fetchCoinList();
    if (!list) return null;
    const matches = list.filter((c) => c.symbol === symbol);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      // Symbol collision — common for short tickers (e.g. multiple
      // "USD"-named tokens). Preferring the highest-cap match needs
      // an extra `/coins/markets` round-trip that's not worth it
      // here; surface the ambiguity and let the orchestrator log it.
      this.logger.debug(
        { symbol, candidates: matches.map((m) => m.id).slice(0, 5) },
        'CoinGecko symbol collision; not auto-resolving'
      );
      return null;
    }
    const match = matches[0];
    if (!match) return null;
    return { coingecko: { id: match.id, symbol: match.symbol.toUpperCase() } };
  }

  /**
   * Free-text symbol/name search via CoinGecko's `/search` endpoint.
   * Free tier requires no API key. Tight 3s timeout because the api
   * caller merges results across providers via Promise.allSettled.
   */
  async searchTokens(query: string, limit = 10): Promise<TokenSearchResult[]> {
    const url = `${this.baseUrl()}/search?query=${encodeURIComponent(query)}`;
    try {
      const response = await this.limiter.execute(() =>
        fetchWithTimeout(url, { headers: this.headers() }, 3000, 0)
      );
      if (!response.ok) {
        this.logger.warn({ status: response.status, query }, 'CoinGecko /search non-OK');
        return [];
      }
      const data = (await response.json()) as {
        coins?: Array<{
          id: string;
          symbol: string;
          name: string;
          large?: string;
        }>;
      };
      const coins = data.coins ?? [];
      return coins.slice(0, limit).map((coin) => ({
        symbol: coin.symbol.toUpperCase(),
        name: coin.name,
        type: 'Crypto',
        currency: 'USD',
        provider: 'coingecko',
        providerMetadata: {
          id: coin.id,
          searchResult: coin,
        },
      }));
    } catch (err) {
      this.logger.debug({ err, query }, 'CoinGecko search failed');
      return [];
    }
  }

  /**
   * Cache `/coins/list` at process scope. CoinGecko's free tier caps
   * the endpoint hard but the response barely changes minute-to-minute.
   */
  private async fetchCoinList(): Promise<CoinListEntry[] | null> {
    if (this.coinListCache) return this.coinListCache;
    const url = `${this.baseUrl()}/coins/list`;
    try {
      const response = await this.limiter.execute(async () =>
        fetchWithTimeout(url, { headers: this.headers() })
      );
      if (!response.ok) return null;
      const data = (await response.json()) as CoinListEntry[];
      this.coinListCache = data;
      return data;
    } catch (err) {
      this.logger.warn({ err }, 'CoinGecko /coins/list fetch failed');
      return null;
    }
  }

  // ============================================================
  // Internals
  // ============================================================

  private async requestSimplePrice(ids: string, vs: string): Promise<SimplePriceResponse | null> {
    const url = `${this.baseUrl()}/simple/price?ids=${ids}&vs_currencies=${vs}`;
    try {
      const response = await this.limiter.execute(async () =>
        fetchWithTimeout(url, { headers: this.headers() })
      );
      if (!response.ok) {
        this.logger.warn(
          { status: response.status, vs },
          'CoinGecko /simple/price returned non-OK'
        );
        return null;
      }
      return (await response.json()) as SimplePriceResponse;
    } catch (err) {
      this.logger.warn({ err, vs }, 'CoinGecko /simple/price failed');
      return null;
    }
  }

  private baseUrl(): string {
    return this.opts.apiKey ? COINGECKO_PRO_BASE_URL : COINGECKO_BASE_URL;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.apiKey) headers['x-cg-pro-api-key'] = this.opts.apiKey;
    return headers;
  }
}

export const coingeckoFactory: ProviderFactory = async (deps) => {
  // CoinGecko Demo/Public API: ~30 calls/min (we use 25 for safety
  // margin); Pro tiers go higher but the namespace + rate window
  // pattern is the same.
  const limiter = createOutflowLimiter({
    maxRequests: 25,
    windowMs: 60 * 1000,
    redis: deps.redis ?? undefined,
    namespace: 'coingecko',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'coingecko',
    limiter,
    registeredFrom: 'providers/coingecko',
    description: 'CoinGecko: 25 req / 60s',
  });
  return new CoinGeckoProvider(registered, {
    apiKey: deps.env.COINGECKO_API_KEY,
  });
};

export { resolveCoingeckoId, WELL_KNOWN_COINGECKO_IDS } from './well-known-ids';
