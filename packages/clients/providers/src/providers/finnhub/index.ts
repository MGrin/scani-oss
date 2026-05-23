/**
 * `FinnhubProvider` — equity prices for US-listed stocks/ETFs.
 *
 * Free tier covers US equities only; non-US listings (LSE `.L`,
 * Toronto `.TO`, etc.) fall through to other providers (paid tier
 * or pool-credentialed IBKR — IBKR is the recommended replacement
 * for non-US equities post-refactor).
 *
 * Capabilities:
 *  - `current-price`: per-symbol `/quote?symbol=AAPL` calls. Finnhub
 *    has no batch endpoint; the orchestrator can issue per-token
 *    calls in parallel since each one is rate-limited under the
 *    same namespace.
 *  - `historical-price`: per-symbol `/stock/candle?symbol=...&resolution=D
 *    &from=...&to=...`. Returns columnar `{ c[], h[], l[], o[], t[],
 *    s: 'ok'|'no_data', v[] }`. Free tier: 1 year of bars per call,
 *    so the chunked walk in `fetchCandles` paginates multi-year
 *    backfill into 1-year windows.
 *  - `token-identity`: writes back a `finnhub.symbol` (and `exchange`
 *    where deducible from the suffix) so subsequent calls don't
 *    have to redo symbol normalization.
 *
 * The `convertPrice` callback is passed as a constructor dep
 * (CoinGecko/DeFiLlama's pattern) and per-symbol provider state lives
 * on `providerMetadata.finnhub`.
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
import { isFiatCode } from '../../core/utils/fiat-codes';
import type { CurrencyConverter } from '../coingecko';
import { detectExchangeInfo, normalizeForFinnhubSymbol } from './symbol';

const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';

// Free-tier `/stock/candle` returns up to 1 year of daily bars per call.
// Chunked walk advances by this many seconds between windows.
const FINNHUB_MAX_RANGE_SECS = 365 * 24 * 60 * 60;

// Symmetric ±1 day window around the target timestamp for
// single-point historical lookups — the closest daily bar will be
// inside this range as long as the market traded on at least one of
// the surrounding days.
const SINGLE_POINT_PADDING_SECS = 24 * 60 * 60;

interface FinnhubQuoteResponse {
  c: number;
  d: number;
  dp: number;
  h: number;
  l: number;
  o: number;
  pc: number;
  t: number;
}

interface FinnhubCandleResponse {
  s: 'ok' | 'no_data';
  c?: number[];
  h?: number[];
  l?: number[];
  o?: number[];
  t?: number[];
  v?: number[];
}

interface CandleBar {
  timeSec: number;
  close: number;
}

export class FinnhubProvider implements HistoricalPriceProvider, TokenIdentityProvider {
  readonly providerKey = 'finnhub';
  readonly capabilities: readonly Capability[] = [
    'current-price',
    'historical-price',
    'token-identity',
  ];

  private readonly logger: CustomLogger;

  constructor(
    private readonly limiter: OutflowRateLimiter,
    private readonly opts: {
      apiKey: string;
      converter?: CurrencyConverter | undefined;
    }
  ) {
    this.logger = createComponentLogger('provider:finnhub');
  }

  /**
   * US-listed stocks/ETFs only. Two gates, in order:
   *   1. **Require explicit `finnhub.symbol` metadata.** A bare token row
   *      (especially a seeded fiat like RUB/GBP with empty
   *      `provider_metadata`) used to fall through the previous
   *      `!etherscan` heuristic and waste 8 concurrent workers on 403
   *      retries during backfill. The token-identity flow stamps
   *      `finnhub.symbol` whenever a stock is added (search hit or the
   *      nightly identity backfill), so requiring it positively
   *      identifies stock candidates.
   *   2. **Reject non-US exchange suffixes.** Finnhub's free tier
   *      returns 403 for every request to .TO/.NE/.NEO/.L/.DE/.HK/…
   *      listings — let Yahoo Finance / Google Sheets handle those.
   */
  canPrice(t: Token): boolean {
    const meta = (t.providerMetadata as TokenMetadata | null)?.finnhub;
    if (!meta?.symbol) return false;
    if (detectExchangeInfo(meta.symbol)) return false;
    return true;
  }

  async fetchCurrentPrice(t: Token, ctx: ProviderContext): Promise<PriceQuote | null> {
    const symbol = this.resolveSymbol(t);
    if (!symbol) return null;

    const url = `${FINNHUB_BASE_URL}/quote?symbol=${encodeURIComponent(symbol)}&token=${this.opts.apiKey}`;
    try {
      const response = await this.limiter.execute(async () => fetchWithTimeout(url));
      if (!response.ok) {
        this.logger.warn({ status: response.status, symbol }, 'Finnhub /quote non-OK');
        return null;
      }
      const data = (await response.json()) as FinnhubQuoteResponse;
      if (!data.c || data.c <= 0) return null;
      return this.toQuote(t, ctx, String(data.c), ctx.timestamp ?? new Date(), 'finnhub');
    } catch (err) {
      this.logger.debug({ err, symbol }, 'Finnhub quote failed');
      return null;
    }
  }

  async fetchHistoricalPrice(t: Token, at: Date, ctx: ProviderContext): Promise<PriceQuote | null> {
    const symbol = this.resolveSymbol(t);
    if (!symbol) return null;

    const targetSec = Math.floor(at.getTime() / 1000);
    const fromSec = targetSec - SINGLE_POINT_PADDING_SECS;
    const toSec = targetSec + SINGLE_POINT_PADDING_SECS;

    try {
      const bars = await this.fetchCandles(symbol, fromSec, toSec);
      const closest = pickClosestBar(bars, targetSec);
      if (!closest) return null;
      return this.toQuote(
        t,
        ctx,
        String(closest.close),
        new Date(closest.timeSec * 1000),
        'finnhub_historical'
      );
    } catch (err) {
      this.logger.debug({ err, symbol, at }, 'Finnhub historical lookup failed');
      return null;
    }
  }

  async fetchHistoricalRange(
    t: Token,
    from: Date,
    to: Date,
    ctx: ProviderContext
  ): Promise<PriceQuote[]> {
    const symbol = this.resolveSymbol(t);
    if (!symbol) return [];

    const fromSec = Math.floor(from.getTime() / 1000);
    const toSec = Math.floor(to.getTime() / 1000);
    if (toSec < fromSec) return [];

    try {
      const bars = await this.fetchCandles(symbol, fromSec, toSec);
      const out: PriceQuote[] = [];
      for (const bar of bars) {
        const quote = await this.toQuote(
          t,
          ctx,
          String(bar.close),
          new Date(bar.timeSec * 1000),
          'finnhub_historical'
        );
        if (quote) out.push(quote);
      }
      return out;
    } catch (err) {
      this.logger.debug({ err, symbol, from, to }, 'Finnhub historical range failed');
      return [];
    }
  }

  /**
   * Build the `finnhub.symbol` metadata entry from a partial token.
   * Cheap — no network call, just symbol normalization. The
   * `exchange` field is derived from the suffix when present.
   *
   * Skip chain-native tokens (Solana mints, EVM contracts, BTC UTXO
   * tokens, etc.) — Finnhub indexes US-listed equities; stamping
   * `finnhub.symbol = 'EPJFWDD5'` on a Solana SPL token both pollutes
   * `provider_metadata` and burns Finnhub's free-tier quota on
   * guaranteed-403 lookups during pricing.
   */
  async enrichTokenIdentity(
    partial: Partial<NewToken>,
    opts?: { force?: boolean }
  ): Promise<Partial<TokenMetadata> | null> {
    const meta = partial.providerMetadata as TokenMetadata | undefined;
    if (meta?.finnhub?.symbol && !opts?.force) return null;
    if (isChainNativeToken(meta)) return null;
    const sym = partial.symbol;
    if (!sym) return null;
    // Fiat ISO-4217 codes (USD, EUR, GBP, …) collide with US-listed
    // equity tickers Finnhub indexes (USD = ProShares Ultra
    // Semiconductors, EUR = ProShares Ultra Euro, …). Stamping
    // finnhub.symbol on a fiat token routes its pricing through the
    // equity pipeline and pollutes the screenshot-parse review UI.
    // Skip enrichment for fiat codes — Frankfurter / ExchangeRate-API
    // own the fiat-pricing path.
    if (isFiatCode(sym)) return null;
    const normalized = normalizeForFinnhubSymbol(sym);
    if (!normalized) return null;
    const exchangeInfo = detectExchangeInfo(sym);
    return {
      finnhub: {
        symbol: normalized,
        ...(exchangeInfo ? { exchange: exchangeInfo.exchange } : {}),
      },
    };
  }

  /**
   * Free-text symbol/name search. Backs the api `tokens.search` flow
   * for stocks/ETFs/funds/bonds/commodities. Bails with `[]` when no
   * API key is set (free-tier requires one). Tight 3s timeout + zero
   * retries because the caller handles partial-result merging.
   */
  async searchTokens(query: string, limit = 10): Promise<TokenSearchResult[]> {
    if (!this.opts.apiKey) return [];
    const url = `${FINNHUB_BASE_URL}/search?q=${encodeURIComponent(query)}&token=${this.opts.apiKey}`;
    try {
      const response = await this.limiter.execute(() => fetchWithTimeout(url, undefined, 3000, 0));
      if (!response.ok) {
        this.logger.warn({ status: response.status, query }, 'Finnhub /search non-OK');
        return [];
      }
      const data = (await response.json()) as {
        count?: number;
        result?: Array<{
          description: string;
          displaySymbol: string;
          symbol: string;
          type: string;
        }>;
      };
      // Finnhub returns every regional listing for a popular ticker
      // (TSLA → TSLA, TSLA.TO, TSLA.MX, TSLA.NE, TSLA.DE, …) in
      // unspecified order. Sort exact symbol/displaySymbol matches to
      // the front before truncating so the bare ticker survives the
      // `limit` cut even when 20+ variants appear upstream.
      const items = data.result ?? [];
      const queryUpper = query.toUpperCase();
      const ranked = [...items].sort((a, b) => {
        const aExact =
          (a.displaySymbol || a.symbol || '').toUpperCase() === queryUpper ||
          (a.symbol || '').toUpperCase() === queryUpper
            ? 0
            : 1;
        const bExact =
          (b.displaySymbol || b.symbol || '').toUpperCase() === queryUpper ||
          (b.symbol || '').toUpperCase() === queryUpper
            ? 0
            : 1;
        return aExact - bExact;
      });
      return ranked.slice(0, limit).map((item) => {
        const rawType = item.type?.toLowerCase() ?? '';
        let normalisedType = 'Equity';
        if (rawType.includes('etf')) normalisedType = 'ETF';
        else if (rawType.includes('fund')) normalisedType = 'Mutual Fund';
        else if (rawType.includes('bond')) normalisedType = 'Bond';
        else if (rawType.includes('commodity')) normalisedType = 'Commodity';
        const finalSymbol = item.displaySymbol || item.symbol;
        const exchangeInfo = detectExchangeInfo(finalSymbol);
        return {
          symbol: finalSymbol,
          name: item.description,
          type: normalisedType,
          currency: exchangeInfo?.currency ?? 'USD',
          exchange: exchangeInfo?.exchange,
          provider: 'finnhub',
          providerMetadata: {
            searchResult: item,
            ...(exchangeInfo ? { exchangeInfo } : {}),
          },
        };
      });
    } catch (err) {
      this.logger.debug({ err, query }, 'Finnhub search failed');
      return [];
    }
  }

  // ============================================================
  // Internals
  // ============================================================

  private resolveSymbol(t: Token): string | null {
    const meta = (t.providerMetadata as TokenMetadata | null)?.finnhub;
    const raw = meta?.symbol ?? t.symbol;
    const symbol = normalizeForFinnhubSymbol(raw);
    return symbol || null;
  }

  /**
   * Walk `[fromSec, toSec]` in 1-year windows, issuing one
   * `/stock/candle` call per window. Returns every (time, close) pair
   * across the full range in chronological order. Empty windows
   * (`s: 'no_data'`) advance silently rather than aborting — the
   * caller may have spanned a delisting or a market closure.
   */
  private async fetchCandles(symbol: string, fromSec: number, toSec: number): Promise<CandleBar[]> {
    const all: CandleBar[] = [];
    let windowFrom = fromSec;
    while (windowFrom <= toSec) {
      const windowTo = Math.min(windowFrom + FINNHUB_MAX_RANGE_SECS, toSec);
      const url =
        `${FINNHUB_BASE_URL}/stock/candle?symbol=${encodeURIComponent(symbol)}` +
        `&resolution=D&from=${windowFrom}&to=${windowTo}&token=${this.opts.apiKey}`;
      const response = await this.limiter.execute(async () => fetchWithTimeout(url));
      if (!response.ok) {
        this.logger.warn(
          { status: response.status, symbol, from: windowFrom, to: windowTo },
          'Finnhub /stock/candle non-OK'
        );
        break;
      }
      const data = (await response.json()) as FinnhubCandleResponse;
      if (data.s === 'ok' && Array.isArray(data.t) && Array.isArray(data.c)) {
        const len = Math.min(data.t.length, data.c.length);
        for (let i = 0; i < len; i++) {
          const tSec = data.t[i];
          const close = data.c[i];
          if (typeof tSec !== 'number' || typeof close !== 'number') continue;
          if (!Number.isFinite(close) || close <= 0) continue;
          all.push({ timeSec: tSec, close });
        }
      }
      if (windowTo === toSec) break;
      windowFrom = windowTo + 1;
    }
    all.sort((a, b) => a.timeSec - b.timeSec);
    return all;
  }

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

// True when the token already has metadata indicating it's a
// chain-native asset (Solana mint, EVM contract, BTC UTXO, etc.).
// These never have meaningful Finnhub representations — the equity
// market doesn't index them.
function isChainNativeToken(meta: TokenMetadata | undefined): boolean {
  if (!meta) return false;
  const m = meta as Record<string, unknown>;
  if (m.solana && typeof m.solana === 'object') return true;
  if (m.etherscan && typeof m.etherscan === 'object') return true;
  if (m.bitcoin && typeof m.bitcoin === 'object') return true;
  if (m.tron && typeof m.tron === 'object') return true;
  if (m.ton && typeof m.ton === 'object') return true;
  return false;
}

function pickClosestBar(bars: CandleBar[], targetSec: number): CandleBar | null {
  if (bars.length === 0) return null;
  let best = bars[0];
  if (!best) return null;
  let bestDiff = Math.abs(best.timeSec - targetSec);
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar) continue;
    const diff = Math.abs(bar.timeSec - targetSec);
    if (diff < bestDiff) {
      best = bar;
      bestDiff = diff;
    }
  }
  return best;
}

export const finnhubFactory: ProviderFactory = async (deps) => {
  const apiKey = deps.env.FINNHUB_API_KEY ?? '';
  if (!apiKey) {
    // Boot-time soft warn; the provider stays registered but every
    // call short-circuits in `fetchCurrentPrice` because the URL
    // has an empty token. This avoids a hard crash in dev where the
    // key isn't configured yet.
    // eslint-disable-next-line no-console
    console.warn(
      'FinnhubProvider: FINNHUB_API_KEY not set; provider will return null for every call'
    );
  }
  // Free tier: 60 req/min — we cap at 50 for safety.
  const limiter = createOutflowLimiter({
    maxRequests: 50,
    windowMs: 60 * 1000,
    redis: deps.redis ?? undefined,
    namespace: 'finnhub',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'finnhub',
    limiter,
    registeredFrom: 'providers/finnhub',
    description: 'Finnhub: 50 req / 60s',
  });
  return new FinnhubProvider(registered, { apiKey });
};

export { detectExchangeInfo, normalizeForFinnhubSymbol } from './symbol';
