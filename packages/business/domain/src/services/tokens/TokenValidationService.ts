import { getCloudClient } from '@scani/cloud-client/runtime';
import { createComponentLogger } from '@scani/logging';
import { Service } from 'typedi';

// Service-local result types kept stable for `ScreenshotParsingService`,
// the only remaining external consumer. Distinct from `TokenMetadata`
// in `@scani/db/schema/tokens` (which models the provider-namespaced
// jsonb column on the `tokens` row); this is the flat upstream-search
// result shape returned from CoinGecko / Finnhub probes.
export interface TokenMetadata {
  symbol: string;
  name: string;
  type: string;
  currency?: string;
  exchange?: string;
  description?: string;
  provider: 'finnhub' | 'coingecko' | 'defillama';
  providerMetadata: Record<string, unknown>;
}

export interface ValidationResult {
  isValid: boolean;
  metadata?: TokenMetadata;
  error?: string;
}

/**
 * Resolves a candidate symbol against the data-provider's tokens.search
 * registry — formerly an api-process direct-HTTP service hitting Finnhub
 * + CoinGecko itself. Now a thin wrapper over `@scani/cloud-client` so
 * upstream API keys live exclusively on the data-provider tier.
 *
 * Used by `ScreenshotParsingService` to validate symbols extracted from
 * portfolio screenshots before persisting them. Returns the canonical
 * symbol/name from the upstream search index when found; the caller
 * falls back to the user-typed value otherwise.
 *
 * The previous version (pre-2026-04-29) also exposed
 * `validateTokenByCoinGeckoId` and `validateTokenByContractAddress`,
 * but neither had a consumer. Removed alongside the inlined
 * Finnhub/CoinGecko/DeFiLlama HTTP clients and process-env config block.
 */
@Service()
export class TokenValidationService {
  private readonly logger = createComponentLogger('token-validation');

  /**
   * Probe `symbol` against the data-provider's federated token search.
   * Returns the first exact symbol match (case-insensitive); falls
   * through to "not found" when the cloud client isn't configured or
   * no provider knows the symbol.
   *
   * `tokenTypeCode` narrows the consumer's expectation (`'crypto'`
   * → CoinGecko, anything else → Finnhub stocks), but the data-provider
   * router fans out to every registered identity-search provider, so
   * the type hint just biases match-priority on the caller side.
   */
  async validateToken(symbol: string, tokenTypeCode?: string): Promise<ValidationResult> {
    const cloud = getCloudClient();
    if (!cloud) {
      // OSS / direct mode without a configured data-provider — a real
      // dev-stack always sets SCANI_CLOUD_URL via docker compose, so
      // hitting this branch in production is a misconfiguration.
      return { isValid: false, error: 'Cloud client not configured' };
    }

    let results: Awaited<ReturnType<typeof cloud.tokens.search.query>>;
    try {
      results = await cloud.tokens.search.query({ query: symbol, limit: 10 });
    } catch (err) {
      this.logger.warn(
        { symbol, err: err instanceof Error ? err.message : String(err) },
        'data-provider tokens.search failed'
      );
      return {
        isValid: false,
        error: err instanceof Error ? err.message : 'Token validation failed',
      };
    }

    const symbolUpper = symbol.toUpperCase();
    // Bias by tokenTypeCode when the caller knows what it's looking
    // for: 'crypto' prefers CoinGecko, anything else prefers Finnhub.
    const wantsCrypto = tokenTypeCode === 'crypto';
    const sorted = [...results].sort((a, b) => {
      const aHit = a.symbol.toUpperCase() === symbolUpper ? 0 : 1;
      const bHit = b.symbol.toUpperCase() === symbolUpper ? 0 : 1;
      if (aHit !== bHit) return aHit - bHit;
      const rank = (provider: string) =>
        wantsCrypto ? (provider === 'coingecko' ? 0 : 1) : provider === 'finnhub' ? 0 : 1;
      return rank(a.provider) - rank(b.provider);
    });

    const exact = sorted.find((r) => r.symbol.toUpperCase() === symbolUpper);
    if (!exact) {
      return {
        isValid: false,
        error: `Token ${symbol} not found in any supported provider (Finnhub, CoinGecko)`,
      };
    }

    return {
      isValid: true,
      metadata: {
        symbol: exact.symbol,
        name: exact.name,
        type: exact.type,
        currency: exact.currency,
        exchange: exact.exchange,
        provider: exact.provider as TokenMetadata['provider'],
        providerMetadata: exact.providerMetadata ?? {},
      },
    };
  }
}
