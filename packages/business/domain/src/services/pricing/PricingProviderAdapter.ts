/**
 * `PricingProviderAdapter` — wraps a registry `CurrentPriceProvider`
 * (optionally also a `HistoricalPriceProvider`) and exposes the batch
 * `fetchPrices(tokens, ctx) -> PricingResult[]` shape `PricingService`
 * is built around.
 *
 * The registry's per-token capability methods are the right contract
 * for everyone EXCEPT PricingService, which orchestrates dedup,
 * fallback chains and circuit-breaking on top of batched provider
 * calls. This adapter keeps PricingService's batch orientation intact
 * while letting it consume the registry's per-token shape underneath.
 *
 * Every caller asks for a current price (foundation A3): the adapter
 * uses `fetchCurrentPrices?` (the optional batch hint — CoinGecko /
 * DeFiLlama implement it) or falls back to per-token
 * `fetchCurrentPrice`. Past prices are the history backfill's, which
 * asks the providers itself.
 */

import type { Token } from '@scani/db/schema';
import type { CurrentPriceProvider } from '@scani/providers/core/capabilities';
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

export type PricingProviderKey =
  | 'exchangeRate'
  | 'coinGecko'
  | 'defiLlama'
  | 'finnhub'
  | 'googleSheets';

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

    // Prefer the batch hint when present.
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
