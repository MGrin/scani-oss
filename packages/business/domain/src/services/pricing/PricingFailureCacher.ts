import { logger } from '@scani/logging';
import { Service } from 'typedi';
import type { PricingResult } from './PricingProviderAdapter';

/**
 * Translates a failure the router caught from a provider into a
 * `PricingResult`. A network error is thrown, so the pricing retry pass sees
 * it; anything else becomes a '0' row, which the writer drops and the router
 * reads as a failure to fall back from. The router passes no response, so
 * the error itself is all there is to judge.
 */
@Service()
export class PricingFailureCacher {
  cacheFailure(
    tokenId: string,
    timestamp: Date,
    providerName: string,
    error: unknown
  ): PricingResult {
    if (isNetworkError(error)) {
      logger.debug(
        { error, tokenId, provider: providerName },
        `${providerName}: Not caching network_error, will retry`
      );
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`${providerName} network_error: ${errorMessage}`);
    }

    logger.debug(
      { error, tokenId, provider: providerName },
      `${providerName}: Caching unknown_error`
    );
    return { tokenId, price: '0', timestamp, source: `${providerName}_unknown_error` };
  }
}

function isNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const { code } = error as { code: unknown };
  return code === 'ECONNRESET' || code === 'ENOTFOUND';
}
