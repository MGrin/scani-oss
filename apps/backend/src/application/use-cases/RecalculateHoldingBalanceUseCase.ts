import Decimal from 'decimal.js';
import { Service } from 'typedi';
import type { TransactionTypeRepository } from '../../infrastructure/repositories/EnumRepositories';
import type { HoldingRepository } from '../../infrastructure/repositories/HoldingRepository';
import type { TransactionRepository } from '../../infrastructure/repositories/TransactionRepository';
import { BaseService } from '../services/BaseService';

/**
 * RecalculateHoldingBalanceUseCase
 *
 * Recalculates a holding's balance by summing all its transactions.
 * This ensures the balance stays in sync with transaction history.
 *
 * **Transaction Types Impact:**
 * - deposit, buy, receive, airdrop, interest, reward, opening_balance → ADD to balance
 * - withdrawal, sell, send, fee → SUBTRACT from balance
 * - swap → Special case (handled separately)
 */
@Service()
export class RecalculateHoldingBalanceUseCase extends BaseService {
  constructor(
    private readonly holdingRepository: HoldingRepository,
    private readonly transactionRepository: TransactionRepository,
    private readonly transactionTypeRepository: TransactionTypeRepository
  ) {
    super('RecalculateHoldingBalanceUseCase');
  }

  /**
   * Execute the use case to recalculate holding balance
   *
   * @param holdingId - The holding to recalculate
   * @returns The updated balance as a string
   */
  async execute(holdingId: string): Promise<string> {
    try {
      this.logInfo('Recalculating holding balance', { holdingId });

      // Verify holding exists
      const holding = await this.holdingRepository.findById(holdingId);
      this.assertExists(holding, `Holding with ID ${holdingId} not found`);

      // Get all transactions for this holding
      const transactions = await this.transactionRepository.findByHolding(holdingId);

      if (transactions.length === 0) {
        // No transactions, balance should be 0
        const updated = await this.holdingRepository.update(holdingId, {
          balance: '0',
          lastUpdated: new Date(),
        });
        this.logInfo('No transactions found, balance set to 0', { holdingId });
        return updated?.balance || '0';
      }

      // Calculate balance from transactions
      let balance = new Decimal(0);

      for (const transaction of transactions) {
        // Get transaction type to determine if it's additive or subtractive
        const transactionType = await this.transactionTypeRepository.findById(transaction.typeId);

        if (!transactionType) {
          this.logWarning('Transaction type not found, skipping transaction', {
            transactionId: transaction.id,
            typeId: transaction.typeId,
          });
          continue;
        }

        const amount = new Decimal(transaction.amount);

        // Determine if this transaction adds or subtracts from balance
        switch (transactionType.code) {
          // Additive transactions
          case 'deposit':
          case 'buy':
          case 'receive':
          case 'airdrop':
          case 'interest':
          case 'reward':
          case 'opening_balance':
            balance = balance.plus(amount);
            this.logDebug('Adding transaction to balance', {
              transactionId: transaction.id,
              type: transactionType.code,
              amount: amount.toString(),
              runningBalance: balance.toString(),
            });
            break;

          // Subtractive transactions
          case 'withdrawal':
          case 'sell':
          case 'send':
          case 'fee':
            balance = balance.minus(amount);
            this.logDebug('Subtracting transaction from balance', {
              transactionId: transaction.id,
              type: transactionType.code,
              amount: amount.toString(),
              runningBalance: balance.toString(),
            });
            break;

          // Swap is complex - may need special handling
          case 'swap':
            this.logWarning('Swap transaction found, may need special handling', {
              transactionId: transaction.id,
              holdingId,
            });
            // For now, treat as neutral (no impact)
            // TODO: Implement proper swap handling
            break;

          default:
            this.logWarning('Unknown transaction type, skipping', {
              transactionId: transaction.id,
              typeCode: transactionType.code,
            });
            break;
        }
      }

      // Ensure balance is not negative (data integrity check)
      if (balance.isNegative()) {
        this.logError('Calculated balance is negative!', {
          holdingId,
          calculatedBalance: balance.toString(),
          transactionCount: transactions.length,
        });
        // Don't throw error, but log it for investigation
        // In production, you might want to alert or handle this differently
      }

      // Update the holding with the calculated balance
      const updated = await this.holdingRepository.update(holdingId, {
        balance: balance.toString(),
        lastUpdated: new Date(),
      });

      this.logInfo('Holding balance recalculated successfully', {
        holdingId,
        oldBalance: holding.balance,
        newBalance: balance.toString(),
        transactionCount: transactions.length,
      });

      return updated?.balance || balance.toString();
    } catch (error) {
      throw this.handleError(error, 'execute');
    }
  }

  /**
   * Batch recalculate balances for multiple holdings
   * Useful for bulk operations or data fixes
   *
   * @param holdingIds - Array of holding IDs to recalculate
   * @returns Map of holding ID to new balance
   */
  async executeBatch(holdingIds: string[]): Promise<Map<string, string>> {
    try {
      this.logInfo('Batch recalculating holding balances', {
        count: holdingIds.length,
      });

      const results = new Map<string, string>();

      for (const holdingId of holdingIds) {
        try {
          const newBalance = await this.execute(holdingId);
          results.set(holdingId, newBalance);
        } catch (error) {
          this.logError('Failed to recalculate holding balance', {
            holdingId,
            error,
          });
          // Continue with other holdings
        }
      }

      this.logInfo('Batch recalculation completed', {
        total: holdingIds.length,
        successful: results.size,
        failed: holdingIds.length - results.size,
      });

      return results;
    } catch (error) {
      throw this.handleError(error, 'executeBatch');
    }
  }
}
