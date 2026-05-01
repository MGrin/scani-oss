import { createComponentLogger } from '@scani/logging';
import { Container, Service } from 'typedi';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { PricingService, VaultService } from '../services';

const logger = createComponentLogger('use-case:update-holding-price');

@Service()
export class UpdateHoldingPriceUseCase {
  private readonly holdingRepository = Container.get(HoldingRepository);
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
    const holding = await this.holdingRepository.findById(holdingId);
    if (!holding) {
      throw new Error('Holding not found');
    }
    if (holding.userId !== userId) {
      throw new Error('Unauthorized: Holding does not belong to user');
    }

    try {
      const { price, source, timestamp } = await this.pricingService.fetchAndStoreFreshPrice(
        holding.tokenId,
        baseCurrencySymbol
      );

      // Vault recalc is best-effort — a stale vault total is preferable
      // to failing the price update the user explicitly requested.
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
        source,
        timestamp: timestamp.toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('rate limit') || errorMessage.includes('retryable_error')) {
        throw new Error('Rate limit reached. Please try again in a few moments.');
      }
      if (errorMessage.includes('unavailable') || errorMessage.includes('tier_limitation')) {
        throw new Error(
          'Price provider is currently unavailable for this token. Please try again later.'
        );
      }
      throw new Error(`Failed to update price: ${errorMessage}`);
    }
  }
}
