import type { ConvertPriceFn, CreateFailureResultFn, PricingProvider } from './providers/base';
import { CoinGeckoProvider } from './providers/coingecko';
import { DeFiLlamaProvider } from './providers/defillama';
import { ExchangeRateProvider } from './providers/exchange-rate';
import { FinnhubProvider } from './providers/finnhub';
import { ScaniCloudPricingProvider } from './providers/scani-cloud';
import type { PricingProviderKey } from './types';
import type { RateLimiter } from './utils';

export type ExternalApiMode = 'direct' | 'scani-cloud';

type PrimaryProviderKey = Exclude<PricingProviderKey, 'googleSheets'>;

export interface BuildPricingProvidersArgs {
  mode: ExternalApiMode;
  rateLimiters: Record<PrimaryProviderKey, RateLimiter>;
  convertPrice: ConvertPriceFn;
  createFailureResult: CreateFailureResultFn;
  logger: (componentName: string) => import('pino').Logger;
  scaniCloud?: { baseUrl: string; clientToken: string };
}

/**
 * Build the registry of pricing providers for each primary key. In `direct`
 * mode (Tier 1 / Tier 3) we return the historical provider classes that hit
 * third-party APIs directly. In `scani-cloud` mode (Tier 2), each slot is
 * served by the ScaniCloudPricingProvider which forwards requests through
 * the Scani-hosted proxy.
 */
export function buildPricingProviders(
  args: BuildPricingProvidersArgs
): Record<PrimaryProviderKey, PricingProvider> {
  if (args.mode === 'scani-cloud') {
    const cfg = args.scaniCloud;
    if (!cfg?.baseUrl || !cfg.clientToken) {
      throw new Error(
        'EXTERNAL_API_MODE=scani-cloud requires SCANI_CLOUD_API_URL and SCANI_CLOUD_CLIENT_TOKEN to be set.'
      );
    }
    const make = (key: PrimaryProviderKey): PricingProvider =>
      new ScaniCloudPricingProvider({
        providerKey: key,
        baseUrl: cfg.baseUrl,
        clientToken: cfg.clientToken,
      });
    return {
      exchangeRate: make('exchangeRate'),
      coinGecko: make('coinGecko'),
      defiLlama: make('defiLlama'),
      finnhub: make('finnhub'),
    };
  }

  // Direct mode (default).
  return {
    exchangeRate: new ExchangeRateProvider({
      createFailureResult: args.createFailureResult,
    }),
    coinGecko: new CoinGeckoProvider({
      rateLimiter: args.rateLimiters.coinGecko,
      convertPrice: args.convertPrice,
      createFailureResult: args.createFailureResult,
    }),
    defiLlama: new DeFiLlamaProvider({
      rateLimiter: args.rateLimiters.defiLlama,
      convertPrice: args.convertPrice,
      createFailureResult: args.createFailureResult,
    }),
    finnhub: new FinnhubProvider({
      rateLimiter: args.rateLimiters.finnhub,
      convertPrice: args.convertPrice,
      createFailureResult: args.createFailureResult,
      logger: args.logger('pricing:finnhub'),
    }),
  };
}
