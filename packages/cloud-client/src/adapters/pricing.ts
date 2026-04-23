import type {
  PricingProvider,
  PricingProviderKey,
  ProviderExecutionContext,
  ProviderPriceResult,
  TokenWithProvider,
} from '@scani/pricing-providers';
import { type CloudClient, CloudError } from '../index';

/**
 * Backend/worker-side adapter that implements `PricingProvider` by calling
 * the data-provider's tRPC `pricing.fetchPrices` procedure.
 *
 * The domain's `PricingService` is wired with one `CloudPricingProvider`
 * per provider key (coinGecko, finnhub, defiLlama, exchangeRate). Each
 * instance carries its own `providerKey`, so the call-site code in
 * PricingService — `this.providers[providerKey].fetchPrices(...)` — works
 * unchanged.
 */
export class CloudPricingProvider implements PricingProvider {
  readonly key: PricingProviderKey;
  private readonly client: CloudClient;

  constructor(params: { providerKey: PricingProviderKey; client: CloudClient }) {
    this.key = params.providerKey;
    this.client = params.client;
  }

  async fetchPrices(
    tokens: TokenWithProvider[],
    context: ProviderExecutionContext
  ): Promise<ProviderPriceResult[]> {
    try {
      if (this.key === 'googleSheets') {
        // Google Sheets provider isn't exposed by data-provider (requires
        // per-user DB state — tracked under phase 5 with object storage).
        // Callers routing tokens here should fall through to the domain's
        // GoogleSheetsProvider; returning empty lets PricingService's
        // fallback pipeline pick it up.
        return [];
      }

      const results = await this.client.pricing.fetchPrices.mutate({
        providerKey: this.key as 'exchangeRate' | 'coinGecko' | 'defiLlama' | 'finnhub',
        tokens,
        context: {
          baseCurrency: context.baseCurrency,
          timestamp: context.timestamp,
        },
      });

      // tRPC's httpBatchLink serializes Date as ISO string. Re-hydrate so
      // the domain's downstream code (which calls `.getTime()` on
      // `result.timestamp`) doesn't see a string.
      return results.map((r) => ({
        ...r,
        timestamp: new Date(r.timestamp),
      }));
    } catch (err) {
      throw CloudError.wrap(err, 'PRICING_FETCH_FAILED');
    }
  }
}
