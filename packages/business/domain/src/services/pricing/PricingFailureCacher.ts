import { logger } from '@scani/logging';
import { Container, Service } from 'typedi';
import { TokenRepository } from '../../repositories/TokenRepository';
import type { PricingResult } from './PricingProviderAdapter';

interface FailureCacheStrategy {
  shouldCache: boolean;
  cacheWindow: number;
  sourcePrefix: string;
  isTierLimitation?: boolean;
}

/**
 * Translates upstream provider failures into cacheable `PricingResult`
 * rows. Decides cache windows, throws for transient errors so the
 * pricing retry loop sees them, and stamps tokens with
 * `pricingUnavailable` metadata when the failure looks like a tier
 * limitation so future routing can short-circuit.
 */
@Service()
export class PricingFailureCacher {
  private readonly UNAVAILABLE_CACHE_MS = 60 * 60 * 1000;
  private readonly RETRYABLE_FAILURE_CACHE_MS = 5 * 60 * 1000;

  private readonly tokenRepository = Container.get(TokenRepository);

  cacheFailure(
    tokenId: string,
    timestamp: Date,
    providerName: string,
    error: unknown,
    options?: { response?: Response; dataEmpty?: boolean }
  ): PricingResult {
    const strategy = this.shouldCacheFailure(error, options?.response, options?.dataEmpty);

    if (!strategy.shouldCache) {
      logger.debug(
        { error, tokenId, provider: providerName },
        `${providerName}: Not caching ${strategy.sourcePrefix}, will retry`
      );
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`${providerName} ${strategy.sourcePrefix}: ${errorMessage}`);
    }

    if (strategy.isTierLimitation) {
      this.updateTokenProviderMetadata(tokenId, providerName, strategy.sourcePrefix, error);
    }

    logger.debug(
      {
        error,
        tokenId,
        provider: providerName,
        cacheWindow: strategy.cacheWindow,
        isTierLimitation: strategy.isTierLimitation,
        sourcePrefix: strategy.sourcePrefix,
      },
      `${providerName}: Caching ${strategy.sourcePrefix} for ${strategy.cacheWindow}ms - Google Sheets fallback may be available`
    );

    return {
      tokenId,
      price: '0',
      timestamp,
      source: `${providerName}_${strategy.sourcePrefix}`,
    };
  }

  private shouldCacheFailure(
    error: unknown,
    response?: Response,
    dataEmpty?: boolean
  ): FailureCacheStrategy {
    if (error && typeof error === 'object' && 'code' in error) {
      const nodeError = error as { code: string };
      if (nodeError.code === 'ECONNRESET' || nodeError.code === 'ENOTFOUND') {
        return {
          shouldCache: false,
          cacheWindow: 0,
          sourcePrefix: 'network_error',
        };
      }
    }

    if (
      response &&
      (response.status === 429 || (response.status >= 500 && response.status < 600))
    ) {
      return {
        shouldCache: false,
        cacheWindow: 0,
        sourcePrefix: 'retryable_error',
      };
    }

    if (response && response.status === 403) {
      return {
        shouldCache: true,
        cacheWindow: this.UNAVAILABLE_CACHE_MS,
        sourcePrefix: 'tier_limitation',
        isTierLimitation: true,
      };
    }

    if (response && response.status === 401) {
      return {
        shouldCache: true,
        cacheWindow: this.UNAVAILABLE_CACHE_MS,
        sourcePrefix: 'unauthorized_access',
        isTierLimitation: true,
      };
    }

    if (dataEmpty === true && response?.ok) {
      return {
        shouldCache: true,
        cacheWindow: this.RETRYABLE_FAILURE_CACHE_MS,
        sourcePrefix: 'empty_response',
      };
    }

    if (response && response.status >= 400 && response.status < 500) {
      const isTierIssue = response.status === 404 && this.isPotentialTierLimitation(error);
      return {
        shouldCache: true,
        cacheWindow: this.UNAVAILABLE_CACHE_MS,
        sourcePrefix: isTierIssue ? 'tier_limitation' : 'unavailable',
        isTierLimitation: isTierIssue,
      };
    }

    return {
      shouldCache: true,
      cacheWindow: this.RETRYABLE_FAILURE_CACHE_MS,
      sourcePrefix: 'unknown_error',
    };
  }

  private isPotentialTierLimitation(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    const message = error.message.toLowerCase();
    const tierKeywords = [
      'subscription',
      'plan',
      'tier',
      'premium',
      'upgrade',
      'access denied',
      'not authorized',
      'forbidden',
      'limit exceeded',
    ];

    return tierKeywords.some((keyword) => message.includes(keyword));
  }

  private async updateTokenProviderMetadata(
    tokenId: string,
    providerName: string,
    sourcePrefix: string,
    error: unknown
  ): Promise<void> {
    try {
      const token = await this.tokenRepository.findById(tokenId);
      if (!token) {
        logger.warn(`Token ${tokenId} not found for metadata update`);
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      // Post-migration-0055 metadata is jsonb-typed; reads return an
      // object directly. Defensive cast covers any stale string values
      // still lingering pre-migration.
      let currentMetadata: Record<string, unknown> = {};
      if (token.providerMetadata) {
        currentMetadata =
          typeof token.providerMetadata === 'string'
            ? (JSON.parse(token.providerMetadata) as Record<string, unknown>)
            : (token.providerMetadata as Record<string, unknown>);
      }

      const updatedMetadata = {
        ...currentMetadata,
        pricingUnavailable: {
          provider: providerName,
          reason: sourcePrefix,
          message: errorMessage,
          detectedAt: new Date().toISOString(),
          requiresPremium: sourcePrefix.includes('tier') || sourcePrefix.includes('unauthorized'),
        },
      };

      await this.tokenRepository.update(tokenId, {
        providerMetadata: updatedMetadata,
        updatedAt: new Date(),
      });

      logger.info(
        {
          tokenId,
          symbol: token.symbol,
          provider: providerName,
          sourcePrefix,
          requiresPremium: updatedMetadata.pricingUnavailable.requiresPremium,
        },
        'Updated token metadata for pricing limitation'
      );
    } catch (err) {
      logger.error(
        {
          tokenId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to update token metadata'
      );
    }
  }
}
