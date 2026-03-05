import { Container, Service } from 'typedi';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { TokenPriceRepository } from '../repositories/TokenPriceRepository';
import { TokenRepository } from '../repositories/TokenRepository';
import { PricingService } from '../services/PricingService';
import { VaultService } from '../services/VaultService';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:update-holding-price');

/**
 * Use case for updating a holding's price by forcing a fresh fetch from pricing providers
 *
 * This use case:
 * - Validates holding ownership
 * - Fetches fresh price data from pricing providers (bypassing cache)
 * - Respects rate limiting of pricing providers
 * - Returns updated price information
 */
@Service()
export class UpdateHoldingPriceUseCase {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly pricingService = Container.get(PricingService);
  private readonly vaultService = Container.get(VaultService);

  async execute(
    holdingId: string,
    userId: string,
    baseCurrencySymbol: string
  ): Promise<{
    success: boolean;
    price: string;
    source: string;
    timestamp: string;
  }> {
    logger.debug(
      {
        userId,
        holdingId,
        baseCurrencySymbol,
      },
      'Updating holding price'
    );

    // Verify holding exists and belongs to user
    const holding = await this.holdingRepository.findById(holdingId);

    if (!holding) {
      logger.warn(
        {
          userId,
          holdingId,
        },
        'Holding not found for price update'
      );
      throw new Error('Holding not found');
    }

    if (holding.userId !== userId) {
      logger.warn(
        {
          userId,
          holdingId,
          holdingUserId: holding.userId,
        },
        'Unauthorized price update attempt'
      );
      throw new Error('Unauthorized: Holding does not belong to user');
    }

    // Get the token for this holding
    const token = await this.tokenRepository.findById(holding.tokenId);

    if (!token) {
      logger.warn(
        {
          userId,
          holdingId,
          tokenId: holding.tokenId,
        },
        'Token not found for holding'
      );
      throw new Error('Token not found for this holding');
    }

    logger.info(
      {
        holdingId,
        tokenId: token.id,
        tokenSymbol: token.symbol,
        tokenType: token.typeId,
      },
      'Fetching fresh price for token'
    );

    // Force fresh price fetch by using current timestamp
    // This bypasses the cache as it will be considered "live" data
    const now = new Date();

    try {
      // Fetch fresh price - this will respect rate limiting internally
      const price = await this.pricingService.getTokenPrice(token, baseCurrencySymbol, now);

      // Get the latest price metadata from the database (just inserted by getTokenPrice)
      const baseCurrencyToken = await this.tokenRepository.findBySymbol(baseCurrencySymbol);
      if (!baseCurrencyToken) {
        throw new Error('Base currency token not found');
      }

      const priceMetadata = await this.tokenPriceRepository.findLatestPrice(
        token.id,
        baseCurrencyToken.id
      );

      logger.info(
        {
          holdingId,
          tokenId: token.id,
          tokenSymbol: token.symbol,
          price,
          source: priceMetadata?.source,
          timestamp: priceMetadata?.timestamp,
        },
        'Holding price updated successfully'
      );

      // Recalculate vaults that reference this holding (best-effort, non-blocking)
      try {
        await this.vaultService.recalculateVaultsForHolding(holdingId);
      } catch (vaultError) {
        logger.warn(
          { holdingId, error: vaultError },
          'Failed to recalculate vaults after price update'
        );
      }

      return {
        success: true,
        price,
        source: priceMetadata?.source || 'unknown',
        timestamp: priceMetadata?.timestamp?.toISOString() || now.toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error(
        {
          holdingId,
          tokenId: token.id,
          tokenSymbol: token.symbol,
          error: errorMessage,
        },
        'Failed to update holding price'
      );

      // Check if it's a rate limiting error
      if (errorMessage.includes('rate limit') || errorMessage.includes('retryable_error')) {
        throw new Error('Rate limit reached. Please try again in a few moments.');
      }

      // Check if it's a provider unavailability error
      if (errorMessage.includes('unavailable') || errorMessage.includes('tier_limitation')) {
        throw new Error(
          'Price provider is currently unavailable for this token. Please try again later.'
        );
      }

      // Generic error
      throw new Error(`Failed to update price: ${errorMessage}`);
    }
  }
}
