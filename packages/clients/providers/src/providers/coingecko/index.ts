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
 * The provider asks the API in the base it is given when CoinGecko
 * supports it (USD/EUR/GBP/CHF/JPY and ~40 others), and gives no quote
 * for a base it does not. Every caller asks against USD (foundation A3).
 */

import type { NewToken, Token, TokenMetadata } from '@scani/db/schema';
import { type CustomLogger, createComponentLogger } from '@scani/logging';
import { captureWarning } from '@scani/logging/sentry';
import { createOutflowLimiter, type OutflowRateLimiter } from '@scani/rate-limiter';
import type { ProviderFactory } from '../../core/boot';
import type {
  Capability,
  HistoricalPriceProvider,
  TokenIdentityProvider,
  TokenSearchResult,
} from '../../core/capabilities';
import { recordRefusal } from '../../core/refusals';
import type { PriceQuote, ProviderContext } from '../../core/types';
import { closeDayNearMidnight } from '../../core/utils/bar-day';
import { fetchWithTimeout } from '../../core/utils/fetch';
import {
  contractRefFromMetadata,
  contradictsDeployments,
  resolveCoingeckoId,
  WELL_KNOWN_COINGECKO_IDS,
} from './well-known-ids';

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
  /** Present only because `fetchCoinList` asks for `include_platform=true`. */
  platforms?: Record<string, string | null>;
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
    private readonly opts: { apiKey?: string | undefined } = {}
  ) {
    this.logger = createComponentLogger('provider:coingecko');
  }

  // ============================================================
  // CurrentPriceProvider + HistoricalPriceProvider
  // ============================================================

  /**
   * The CoinGecko id this token may be priced under — the single place
   * every pricing entry point asks, so none of them can resolve a
   * symbol without also weighing the contract address it came with.
   */
  private coingeckoIdFor(t: Token): string | null {
    const metadata = t.providerMetadata as TokenMetadata | null;
    return resolveCoingeckoId({
      metadataId: metadata?.coingecko?.id,
      symbol: t.symbol,
      contract: contractRefFromMetadata(metadata),
    });
  }

  canPrice(t: Token): boolean {
    return Boolean(this.coingeckoIdFor(t));
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
      const id = this.coingeckoIdFor(t);
      if (id) idMap.set(id, t);
    }
    if (idMap.size === 0) return new Map();

    const ids = [...idMap.keys()].join(',');
    const out = new Map<string, PriceQuote>();

    // CoinGecko's vs_currencies covers ~40 fiats + crypto; the request
    // silently returns no values for an unsupported currency, so a token
    // with none simply gets no quote.
    const primary = await this.requestSimplePrice(ids, baseLower);
    if (!primary) return out;

    for (const [id, token] of idMap) {
      const v = primary[id]?.[baseLower];
      if (typeof v !== 'number' || v <= 0) continue;
      out.set(token.id, {
        tokenId: token.id,
        baseTokenId: ctx.baseCurrency.id,
        price: String(v),
        timestamp: ctx.timestamp ?? new Date(),
        barDay: null,
        source: 'coingecko',
      });
    }
    return out;
  }

  /**
   * Range fetch via CoinGecko's `/coins/{id}/market_chart/range` endpoint —
   * returns daily price points for the entire period in a single response.
   * Collapses 365 per-day calls into one, which on a free-tier API key
   * (~10-30 req/min) is the difference between ~15 minutes and ~5 seconds
   * for a 1Y BTC backfill. A base CoinGecko does not quote gets no bars.
   */
  async fetchHistoricalRange(
    t: Token,
    from: Date,
    to: Date,
    ctx: ProviderContext
  ): Promise<PriceQuote[]> {
    const id = this.coingeckoIdFor(t);
    if (!id) return [];
    if (to.getTime() < from.getTime()) return [];

    const baseLower = ctx.baseCurrency.symbol.toLowerCase();
    const fromSec = Math.floor(from.getTime() / 1000);
    const toSec = Math.floor(to.getTime() / 1000);
    const daily = toSec - fromSec > 90 * 86_400;

    // CoinGecko quotes most majors (USD, EUR, GBP, JPY, …).
    const bars = await this.fetchMarketChartRange(id, baseLower, fromSec, toSec);
    return (bars ?? []).map((bar) => ({
      tokenId: t.id,
      baseTokenId: ctx.baseCurrency.id,
      price: String(bar.price),
      timestamp: new Date(bar.timeMs),
      barDay: daily ? closeDayNearMidnight(new Date(bar.timeMs)) : null,
      source: 'coingecko_historical',
    }));
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
      const response = await this.get(url, 'market_chart');
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
    const id = this.coingeckoIdFor(t);
    if (!id) return null;

    // The close of day N is the observation at midnight N + 1.
    const barDay = at.toISOString().slice(0, 10);
    const midnight = new Date(Date.parse(`${barDay}T00:00:00Z`) + 86_400_000);
    const yyyy = midnight.getUTCFullYear();
    const mm = String(midnight.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(midnight.getUTCDate()).padStart(2, '0');
    const dateStr = `${dd}-${mm}-${yyyy}`;

    const url = `${this.baseUrl()}/coins/${encodeURIComponent(id)}/history?date=${dateStr}&localization=false`;
    try {
      const response = await this.get(url, 'history');
      if (!response.ok) return null;
      const data = (await response.json()) as HistoryResponse;
      const baseLower = ctx.baseCurrency.symbol.toLowerCase();
      const direct = data.market_data?.current_price?.[baseLower];
      if (typeof direct === 'number' && direct > 0) {
        return {
          tokenId: t.id,
          baseTokenId: ctx.baseCurrency.id,
          price: String(direct),
          timestamp: midnight,
          barDay,
          source: 'coingecko_historical',
        };
      }
      return null;
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

    // The contract address is the strongest identity signal we were
    // handed and it is what makes the symbol map safe to use: an id
    // inferred from `USDT` must not be stamped onto a contract that is
    // demonstrably not Tether (SC-389).
    const contract = contractRefFromMetadata(partial.providerMetadata as TokenMetadata | undefined);

    const wellKnown = resolveCoingeckoId({ metadataId: undefined, symbol, contract });
    if (wellKnown) {
      return { coingecko: { id: wellKnown, symbol: symbol.toUpperCase() } };
    }
    if (contract && WELL_KNOWN_COINGECKO_IDS[symbol]) {
      this.logger.debug(
        { symbol, contract, candidate: WELL_KNOWN_COINGECKO_IDS[symbol] },
        'CoinGecko well-known id contradicted by contract address; not stamping'
      );
      return null;
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
    // Same rule one layer out: `/coins/list?include_platform=true`
    // carries the match's own deployments, so a single-candidate symbol
    // match is still refused when its contract says otherwise.
    if (contract && contradictsDeployments(match.platforms, contract)) {
      this.logger.debug(
        { symbol, contract, candidate: match.id },
        'CoinGecko symbol match contradicted by contract address; not stamping'
      );
      return null;
    }
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
      const response = await this.get(url, 'search', 3000, 0);
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
    const url = `${this.baseUrl()}/coins/list?include_platform=true`;
    try {
      const response = await this.get(url, 'coins_list');
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
      const response = await this.get(url, 'simple_price');
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

  /**
   * Every CoinGecko request, through the shared limiter. Each 429 CoinGecko
   * sends is counted in Sentry, one issue per tier, retried attempts included,
   * because production runs keyless on the public tier, the one place a
   * per-minute cap bites, and nothing else saw it (SC-1602). The limiter
   * spends one token on up to `retries + 1` upstream requests, so this count
   * is the pressure the limiter does not see.
   */
  private async get(
    url: string,
    endpoint: string,
    timeoutMs?: number,
    retries?: number
  ): Promise<Response> {
    const tier = this.opts.apiKey ? 'pro' : 'public';
    const response = await this.limiter.execute(() =>
      fetchWithTimeout(url, { headers: this.headers() }, timeoutMs, retries, (attempt) => {
        if (attempt.status !== 429) return;
        this.logger.warn({ endpoint, tier }, 'CoinGecko 429');
        captureWarning('CoinGecko 429', { provider: 'coingecko', endpoint, tier }, [
          'coingecko-429',
          tier,
        ]);
      })
    );
    // Only a 429 no retry cleared: that is a price not fetched, and what the
    // quarter-hour run backs off for. Sentry above counts every attempt.
    if (response.status === 429) recordRefusal('coingecko');
    return response;
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
  // No warn lived here before SC-536: an unkeyed CoinGecko silently
  // resolves `baseUrl()` to the free host and omits the `x-cg-pro-api-key`
  // header, so the drop to the public tier left no trace anywhere.
  deps.reportCredentialStatus({
    provider: 'coingecko',
    envVar: 'COINGECKO_API_KEY',
    keyed: Boolean(deps.env.COINGECKO_API_KEY),
    degradedBehaviour: 'drops to the public rate-limited tier instead of the Pro host',
  });
  return new CoinGeckoProvider(registered, {
    apiKey: deps.env.COINGECKO_API_KEY,
  });
};

export {
  type ContractRef,
  contractRefFromMetadata,
  contradictsDeployments,
} from './well-known-ids';
