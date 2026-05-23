/**
 * `PricingProviderAdapter` — wraps a registry `CurrentPriceProvider`
 * (optionally also a `HistoricalPriceProvider`) and exposes the batch
 * `fetchPrices(tokens, ctx) -> PricingResult[]` shape `PricingService`
 * is built around.
 *
 * The registry's per-token capability methods are the right contract
 * for everyone EXCEPT PricingService, which orchestrates caching,
 * dedup, fallback chains, conversion, and circuit-breaking on top of
 * batched provider calls. This adapter keeps PricingService's batch
 * orientation intact while letting it consume the registry's per-token
 * shape underneath.
 *
 * Routing rule: when the requested `ctx.timestamp` differs from "now"
 * by more than `LIVE_PRICE_WINDOW_MS` and the wrapped provider also
 * implements `HistoricalPriceProvider`, the adapter routes per-token
 * to `fetchHistoricalPrice`. Otherwise it uses `fetchCurrentPrices?`
 * (the optional batch hint — CoinGecko / DeFiLlama implement it) or
 * falls back to per-token `fetchCurrentPrice`.
 */

import type { Token } from '@scani/db/schema';
import type {
  CurrentPriceProvider,
  HistoricalPriceProvider,
} from '@scani/providers/core/capabilities';
import type { ProviderContext } from '@scani/providers/core/types';

export interface PricingResult {
  tokenId: string;
  price: string;
  timestamp: Date;
  source: string;
}

export interface RoutedToken {
  token: Token;
  provider: string;
  providerTokenId?: string;
}

export interface PricingExecutionContext {
  baseCurrency: Token;
  timestamp: Date;
}

export interface PricingProvider {
  readonly key: string;
  fetchPrices(tokens: RoutedToken[], context: PricingExecutionContext): Promise<PricingResult[]>;
}

export type ConvertPriceFn = (
  price: string,
  fromCurrency: string,
  toCurrency: string,
  timestamp: Date
) => Promise<string>;

export type PricingProviderKey =
  | 'exchangeRate'
  | 'coinGecko'
  | 'defiLlama'
  | 'finnhub'
  | 'googleSheets';

/**
 * Window inside which a price request is considered "current" — beyond
 * this, the adapter routes to `fetchHistoricalPrice` if available.
 * Mirrors `PricingService.LIVE_PRICE_WINDOW_MS`.
 */
const LIVE_PRICE_WINDOW_MS = 60 * 60 * 1000;

function isHistoricalCapable(p: CurrentPriceProvider): p is HistoricalPriceProvider {
  return typeof (p as HistoricalPriceProvider).fetchHistoricalPrice === 'function';
}

export class PricingProviderAdapter implements PricingProvider {
  constructor(
    readonly key: string,
    private readonly provider: CurrentPriceProvider
  ) {}

  async fetchPrices(
    tokens: RoutedToken[],
    context: PricingExecutionContext
  ): Promise<PricingResult[]> {
    if (tokens.length === 0) return [];

    const newCtx: ProviderContext = {
      baseCurrency: context.baseCurrency,
      timestamp: context.timestamp,
    };

    const isHistorical =
      Math.abs(Date.now() - context.timestamp.getTime()) > LIVE_PRICE_WINDOW_MS &&
      isHistoricalCapable(this.provider);

    if (isHistorical) {
      // Per-token historical fetches. Sequential to keep upstream
      // rate limits predictable; the providers do their own limiter
      // coordination internally.
      const out: PricingResult[] = [];
      const histProvider = this.provider as HistoricalPriceProvider;
      for (const tw of tokens) {
        try {
          const quote = await histProvider.fetchHistoricalPrice(
            tw.token,
            context.timestamp,
            newCtx
          );
          if (quote) {
            out.push({
              tokenId: quote.tokenId,
              price: quote.price,
              timestamp: quote.timestamp,
              source: quote.source,
            });
          } else {
            out.push({
              tokenId: tw.token.id,
              price: '0',
              timestamp: context.timestamp,
              source: `${this.key}_no_data`,
            });
          }
        } catch (err) {
          out.push({
            tokenId: tw.token.id,
            price: '0',
            timestamp: context.timestamp,
            source: `${this.key}_error_${err instanceof Error ? err.message : 'unknown'}`,
          });
        }
      }
      return out;
    }

    // Current path. Prefer batch hint when present.
    const tokenList = tokens.map((t) => t.token);
    if (typeof this.provider.fetchCurrentPrices === 'function') {
      try {
        const map = await this.provider.fetchCurrentPrices(tokenList, newCtx);
        return tokens.map((tw) => {
          const quote = map.get(tw.token.id);
          if (quote) {
            return {
              tokenId: quote.tokenId,
              price: quote.price,
              timestamp: quote.timestamp,
              source: quote.source,
            };
          }
          return {
            tokenId: tw.token.id,
            price: '0',
            timestamp: context.timestamp,
            source: `${this.key}_no_data`,
          };
        });
      } catch (err) {
        return tokens.map((tw) => ({
          tokenId: tw.token.id,
          price: '0',
          timestamp: context.timestamp,
          source: `${this.key}_error_${err instanceof Error ? err.message : 'unknown'}`,
        }));
      }
    }

    // Per-token fallback.
    const out: PricingResult[] = [];
    for (const tw of tokens) {
      try {
        const quote = await this.provider.fetchCurrentPrice(tw.token, newCtx);
        if (quote) {
          out.push({
            tokenId: quote.tokenId,
            price: quote.price,
            timestamp: quote.timestamp,
            source: quote.source,
          });
        } else {
          out.push({
            tokenId: tw.token.id,
            price: '0',
            timestamp: context.timestamp,
            source: `${this.key}_no_data`,
          });
        }
      } catch (err) {
        out.push({
          tokenId: tw.token.id,
          price: '0',
          timestamp: context.timestamp,
          source: `${this.key}_error_${err instanceof Error ? err.message : 'unknown'}`,
        });
      }
    }
    return out;
  }
}

/**
 * Map `PricingProviderKey` (the user-facing routing key in
 * PricingService) → registry `providerKey`. PricingService's
 * `groupTokensByProvider` produces the former; the registry's
 * `getAllCurrentPricers()` lookups consume the latter.
 */
export const PRICING_PROVIDER_REGISTRY_KEYS: Record<PricingProviderKey, string> = {
  exchangeRate: 'frankfurter',
  coinGecko: 'coingecko',
  defiLlama: 'defillama',
  finnhub: 'finnhub',
  googleSheets: 'google-sheets',
};
