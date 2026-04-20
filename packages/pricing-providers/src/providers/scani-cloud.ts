import { createComponentLogger } from '@scani/logging';
import type { ProviderPriceResult, TokenWithProvider } from '../types';
import type { PricingProvider, ProviderExecutionContext } from './base';

/**
 * Tier 2 pricing provider — forwards price requests to the Scani Cloud API
 * (`cloud.scani.xyz`) instead of hitting CoinGecko / Finnhub / DeFiLlama
 * directly. The cloud service owns the paid API keys and applies per-client
 * rate limits against a token; self-hosters on Tier 2 only need to configure
 * `SCANI_CLOUD_CLIENT_TOKEN`.
 *
 * The cloud service itself is not built as part of this migration. This
 * stub throws on use so misconfiguration (mode=scani-cloud but no cloud
 * service) fails loudly rather than silently returning empty results.
 */
export class ScaniCloudPricingProvider implements PricingProvider {
  readonly key: string;
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly log = createComponentLogger('pricing:scani-cloud');

  constructor(params: { providerKey: string; baseUrl: string; clientToken: string }) {
    this.key = params.providerKey;
    this.baseUrl = params.baseUrl.replace(/\/$/, '');
    this.authHeader = `Bearer ${params.clientToken}`;
  }

  async fetchPrices(
    tokens: TokenWithProvider[],
    _context: ProviderExecutionContext
  ): Promise<ProviderPriceResult[]> {
    // Intentionally unimplemented: Tier 2 cloud-proxy service is on the
    // roadmap after the Render → Fly migration ships. When it lands, this
    // method will POST { providerKey, tokens } to
    // `${baseUrl}/v1/pricing/fetch` with the configured Authorization header
    // and return the response body unchanged.
    this.log.error(
      {
        provider: this.key,
        count: tokens.length,
        baseUrl: this.baseUrl,
        authHeaderPresent: this.authHeader.length > 'Bearer '.length,
      },
      'ScaniCloudPricingProvider is a stub — EXTERNAL_API_MODE=scani-cloud is not yet supported'
    );
    throw new Error(
      'EXTERNAL_API_MODE=scani-cloud is not implemented yet. Set EXTERNAL_API_MODE=direct ' +
        'and configure provider API keys directly, or wait for the Scani Cloud release.'
    );
  }
}
