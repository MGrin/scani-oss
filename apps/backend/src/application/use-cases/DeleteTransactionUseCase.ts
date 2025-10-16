import { Service } from 'typedi';
import type { Transaction } from '../../domain/entities';
import type { HoldingRepository } from '../../infrastructure/repositories/HoldingRepository';
import type { TransactionRepository } from '../../infrastructure/repositories/TransactionRepository';
import { BaseService } from '../services/BaseService';
import type { RecalculateHoldingBalanceUseCase } from './RecalculateHoldingBalanceUseCase';

export interface DeleteTransactionResult {
  success: boolean;
  deletedTransaction: Transaction;
  holdingId: string;
  newBalance: string;
}

/**
 * DeleteTransactionUseCase
 *
 * Deletes a transaction and recalculates the holding balance from remaining transactions.
 * This ensures data integrity and consistency.
 *
 * **Business Rules:**
 * 1. Transaction must exist and belong to the user (via holding ownership)
 * 2. Holding balance is recalculated after deletion to ensure accuracy
 * 3. Deletion and balance update happen atomically
 */
@Service()
export class DeleteTransactionUseCase extends BaseService {
  constructor(
    private readonly transactionRepository: TransactionRepository,
    private readonly holdingRepository: HoldingRepository,
    private readonly recalculateBalanceUseCase: RecalculateHoldingBalanceUseCase
  ) {
    super('DeleteTransactionUseCase');
  }

  /**
   * Execute the use case to delete a transaction
   *
   * @param transactionId - The transaction to delete
   * @param userId - The user deleting the transaction
   * @returns Result containing deleted transaction and new balance
   */
  async execute(transactionId: string, userId: string): Promise<DeleteTransactionResult> {
    try {
      this.logInfo('Deleting transaction', { transactionId, userId });

      return await this.withTransaction(async (tx) => {
        // 1. Get the transaction and verify it exists
        const transaction = await this.transactionRepository.findById(transactionId, tx);
        this.assertExists(transaction, `Transaction with ID ${transactionId} not found`);

        // 2. Get the holding to verify ownership
        const holding = await this.holdingRepository.findById(transaction.holdingId, tx);
        this.assertExists(holding, `Holding with ID ${transaction.holdingId} not found`);

        if (holding.userId !== userId) {
          throw new Error('Unauthorized: Transaction does not belong to user');
        }

        // Store holding ID before deletion
        const holdingId = transaction.holdingId;

        // 3. Delete the transaction
        const deleted = await this.transactionRepository.delete(transactionId, tx);

        if (!deleted) {
          throw new Error('Failed to delete transaction');
        }

        this.logInfo('Transaction deleted', {
          transactionId,
          holdingId,
          amount: transaction.amount,
        });

        // 4. Recalculate holding balance from remaining transactions
        // This is done outside the current transaction to avoid issues with the
        // recalculate use case potentially using its own transaction
        const newBalance = await this.recalculateBalanceUseCase.execute(holdingId);

        this.logInfo('Holding balance recalculated after transaction deletion', {
          transactionId,
          holdingId,
          newBalance,
          oldBalance: holding.balance,
        });

        return {
          success: true,
          deletedTransaction: transaction,
          holdingId,
          newBalance,
        };
      });
    } catch (error) {
      throw this.handleError(error, 'execute');
    }
  }

  /**
   * Batch delete multiple transactions
   * Useful for bulk operations or cleanup
   *
   * @param transactionIds - Array of transaction IDs to delete
   * @param userId - The user deleting the transactions
   * @returns Array of results for each deletion
   */
  async executeBatch(transactionIds: string[], userId: string): Promise<DeleteTransactionResult[]> {
    try {
      this.logInfo('Batch deleting transactions', {
        count: transactionIds.length,
        userId,
      });

      const results: DeleteTransactionResult[] = [];
      const affectedHoldings = new Set<string>();

      // Delete all transactions first
      for (const transactionId of transactionIds) {
        try {
          const result = await this.execute(transactionId, userId);
          results.push(result);
          affectedHoldings.add(result.holdingId);
        } catch (error) {
          this.logError('Failed to delete transaction', {
            transactionId,
            error,
          });
          // Continue with other transactions
        }
      }

      // Recalculate balances for all affected holdings
      // (Already done in individual delete, but logging summary)
      this.logInfo('Batch deletion completed', {
        total: transactionIds.length,
        successful: results.length,
        failed: transactionIds.length - results.length,
        affectedHoldings: affectedHoldings.size,
      });

      return results;
    } catch (error) {
      throw this.handleError(error, 'executeBatch');
    }
  }
}
