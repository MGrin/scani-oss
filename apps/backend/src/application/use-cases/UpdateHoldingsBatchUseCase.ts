import Container, { Service } from 'typedi';
import { createComponentLogger } from '../../utils/logger';
import { UpdateHoldingUseCase } from './UpdateHoldingUseCase';

const logger = createComponentLogger('use-case:update-holdings-batch');

export interface HoldingUpdate {
  id: string;
  balance: string;
  lastUpdated?: Date;
}

export interface UpdateHoldingsBatchInput {
  holdings: HoldingUpdate[];
}

export interface UpdateHoldingsBatchResult {
  updated: Array<{
    id: string;
    success: boolean;
    error?: string;
  }>;
  totalUpdated: number;
  totalFailed: number;
}

/**
 * Use case for updating multiple holdings in batch
 *
 * This use case:
 * - Updates balance and lastUpdated for multiple holdings
 * - Uses "continue on error" strategy - one failure doesn't block others
 * - Returns detailed results per holding plus summary statistics
 */
@Service()
export class UpdateHoldingsBatchUseCase {
  private updateHoldingUseCase = Container.get(UpdateHoldingUseCase);

  async execute(
    input: UpdateHoldingsBatchInput,
    userId: string
  ): Promise<UpdateHoldingsBatchResult> {
    logger.debug(
      {
        userId,
        holdingsCount: input.holdings.length,
      },
      'Updating holdings in batch'
    );

    const results = [];
    let successCount = 0;
    let failureCount = 0;

    for (const holdingUpdate of input.holdings) {
      try {
        await this.updateHoldingUseCase.execute(
          holdingUpdate.id,
          {
            balance: holdingUpdate.balance,
            lastUpdated: holdingUpdate.lastUpdated,
          },
          userId
        );

        results.push({
          id: holdingUpdate.id,
          success: true,
        });
        successCount++;
      } catch (error) {
        logger.error(
          {
            error,
            holdingId: holdingUpdate.id,
          },
          'Failed to update holding'
        );
        results.push({
          id: holdingUpdate.id,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        failureCount++;
      }
    }

    logger.info(
      {
        userId,
        totalUpdated: successCount,
        totalFailed: failureCount,
      },
      'Batch update completed'
    );

    return {
      updated: results,
      totalUpdated: successCount,
      totalFailed: failureCount,
    };
  }
}
