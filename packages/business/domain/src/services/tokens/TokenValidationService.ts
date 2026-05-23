import { getCloudClient } from '@scani/cloud-client/runtime';
import { createComponentLogger } from '@scani/logging';
import { isFiatCode } from '@scani/providers/core/utils/fiat-codes';
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
    // for: 'crypto' prefers CoinGecko, 'fiat' prefers DB-backed fiat,
    // anything else prefers Finnhub.
    //
    // Fiat ISO-4217 override: when the symbol is a known fiat code
    // (USD, EUR, GBP, CHF, …), pick the fiat-typed result regardless
    // of the caller's hint. Without this, Finnhub's USD = "ProShares
    // Ultra Semiconductors ETF" wins the tie-break against the DB's
    // fiat USD, and a user uploading a screenshot of cash gets shown
    // an obscure 2x leveraged equity instead of dollars.
    const wantsCrypto = tokenTypeCode === 'crypto';
    const wantsFiat = tokenTypeCode === 'fiat' || isFiatCode(symbolUpper);
    const sorted = [...results].sort((a, b) => {
      const aHit = a.symbol.toUpperCase() === symbolUpper ? 0 : 1;
      const bHit = b.symbol.toUpperCase() === symbolUpper ? 0 : 1;
      if (aHit !== bHit) return aHit - bHit;
      if (wantsFiat) {
        const aFiat = isFiatTypedResult(a) ? 0 : 1;
        const bFiat = isFiatTypedResult(b) ? 0 : 1;
        if (aFiat !== bFiat) return aFiat - bFiat;
      }
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

    // A stock match for a fiat symbol is wrong by definition. The
    // data-provider's `tokens.search` has no DB access, so for a fiat
    // code (USD, EUR, …) the only result is often a same-ticker equity
    // (USD = ProShares Ultra Semiconductors). Reject it rather than hand
    // a stock name/metadata back to the screenshot-parse pipeline.
    if (wantsFiat && !isFiatTypedResult(exact)) {
      return {
        isValid: false,
        error: `No fiat token found for ${symbol} (only non-fiat matches)`,
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

// `tokens.search` returns a union of DB rows (typeName='Fiat Currency')
// and external upstream rows (type='Fiat'/'Equity'/'Crypto'/...). Treat
// either shape as fiat for ranking purposes.
function isFiatTypedResult(r: { type?: string | null; typeName?: string | null }): boolean {
  const a = (r.type ?? '').toLowerCase();
  const b = (r.typeName ?? '').toLowerCase();
  return a === 'fiat' || b.includes('fiat');
}
