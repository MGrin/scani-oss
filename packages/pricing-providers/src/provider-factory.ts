import type { ConvertPriceFn, CreateFailureResultFn, PricingProvider } from './providers/base';
import { CoinGeckoProvider } from './providers/coingecko';
import { DeFiLlamaProvider } from './providers/defillama';
import { ExchangeRateProvider } from './providers/exchange-rate';
import { FinnhubProvider } from './providers/finnhub';
import type { PricingProviderKey } from './types';
import type { RateLimiter } from './utils';

// 'direct' = in-process calls to third-party APIs (local fallback / OSS dev).
// 'cloud'  = delegate to the data-provider service via @scani/cloud-client.
// The legacy 'scani-cloud' mode was removed along with EXTERNAL_API_MODE.
export type ExternalApiMode = 'direct' | 'cloud';

type PrimaryProviderKey = Exclude<PricingProviderKey, 'googleSheets'>;

export interface BuildPricingProvidersArgs {
  mode: ExternalApiMode;
  rateLimiters: Record<PrimaryProviderKey, RateLimiter>;
  convertPrice: ConvertPriceFn;
  createFailureResult: CreateFailureResultFn;
  logger: (componentName: string) => import('pino').Logger;
  /**
   * Pre-built CloudPricingProvider instances (one per primary key). Used
   * when `mode === 'cloud'`; supplied by the caller's DI container so this
   * package stays free of the @scani/cloud-client dependency (which would
   * create a ballast cycle via @scani/data-provider -> @scani/pricing-providers).
   */
  cloudProviders?: Record<PrimaryProviderKey, PricingProvider>;
}

/**
 * Build the registry of pricing providers for each primary key. In `direct`
 * mode we return the historical provider classes that hit third-party APIs
 * directly (used as a dev fallback). In `cloud` mode every slot is served
 * by a CloudPricingProvider that forwards requests to the data-provider.
 */
export function buildPricingProviders(
  args: BuildPricingProvidersArgs
): Record<PrimaryProviderKey, PricingProvider> {
  if (args.mode === 'cloud') {
    if (!args.cloudProviders) {
      throw new Error(
        'buildPricingProviders: mode=cloud requires `cloudProviders` to be supplied by the caller.'
      );
    }
    return args.cloudProviders;
  }

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
