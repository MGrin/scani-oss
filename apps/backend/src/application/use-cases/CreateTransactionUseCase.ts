import Decimal from 'decimal.js';
import { Service } from 'typedi';
import type { Transaction } from '../../domain/entities';
import type { TransactionTypeRepository } from '../../infrastructure/repositories/EnumRepositories';
import type { HoldingRepository } from '../../infrastructure/repositories/HoldingRepository';
import type { TransactionRepository } from '../../infrastructure/repositories/TransactionRepository';
import { BaseService } from '../services/BaseService';
import type { PricingService } from '../services/PricingService';

export interface CreateTransactionInput {
  holdingId: string;
  typeCode: string; // Transaction type code (e.g., 'deposit', 'withdrawal')
  amount: string;
  fee?: string;
  feeTokenId?: string;
  description?: string;
  reference?: string;
  timestamp: Date;
}

/**
 * CreateTransactionUseCase
 *
 * Creates a new transaction and updates the holding balance atomically.
 * Also attempts to fetch and cache the current token price.
 *
 * **Business Rules:**
 * 1. Transaction type must be valid and active
 * 2. Holding must exist and belong to the user
 * 3. Amount must be non-negative
 * 4. Balance is updated based on transaction type (additive vs subtractive)
 * 5. Price fetching is non-blocking (failures are logged but don't prevent transaction creation)
 */
@Service()
export class CreateTransactionUseCase extends BaseService {
  constructor(
    private readonly transactionRepository: TransactionRepository,
    private readonly transactionTypeRepository: TransactionTypeRepository,
    private readonly holdingRepository: HoldingRepository,
    readonly _pricingService: PricingService
  ) {
    super('CreateTransactionUseCase');
  }

  /**
   * Execute the use case to create a transaction
   *
   * @param input - Transaction creation data
   * @param userId - The user creating the transaction
   * @returns The created transaction
   */
  async execute(input: CreateTransactionInput, userId: string): Promise<Transaction> {
    try {
      this.logInfo('Creating transaction', {
        holdingId: input.holdingId,
        type: input.typeCode,
        amount: input.amount,
        userId,
      });

      // Validate amount
      const amount = new Decimal(input.amount);
      if (amount.isNegative()) {
        throw new Error('Transaction amount cannot be negative');
      }

      // Validate fee if provided
      const fee = new Decimal(input.fee || '0');
      if (fee.isNegative()) {
        throw new Error('Transaction fee cannot be negative');
      }

      // Use a database transaction to ensure atomicity
      return await this.withTransaction(async (tx) => {
        // 1. Look up the transaction type by code
        const transactionType = await this.transactionTypeRepository.findByCode(input.typeCode, tx);

        if (!transactionType) {
          throw new Error(`Invalid transaction type: ${input.typeCode}`);
        }

        if (!transactionType.isActive) {
          throw new Error(`Transaction type '${input.typeCode}' is not active`);
        }

        // 2. Verify holding exists and belongs to user
        const holding = await this.holdingRepository.findById(input.holdingId, tx);
        this.assertExists(holding, `Holding with ID ${input.holdingId} not found`);

        if (holding.userId !== userId) {
          throw new Error('Unauthorized: Holding does not belong to user');
        }

        // 3. Create the transaction
        const transaction = await this.transactionRepository.create(
          {
            holdingId: input.holdingId,
            typeId: transactionType.id,
            userId,
            amount: input.amount,
            fee: input.fee || '0',
            feeTokenId: input.feeTokenId || null,
            description: input.description || null,
            reference: input.reference || null,
            timestamp: input.timestamp,
          },
          tx
        );

        this.assertExists(transaction, 'Failed to create transaction');

        // 4. Update holding balance based on transaction type
        const currentBalance = new Decimal(holding.balance);
        let newBalance: Decimal;

        // Determine if transaction adds or subtracts from balance
        const isAdditive = this.isAdditiveTransactionType(transactionType.code);

        if (isAdditive) {
          newBalance = currentBalance.plus(amount);
          this.logDebug('Adding transaction amount to holding balance', {
            transactionId: transaction.id,
            currentBalance: currentBalance.toString(),
            amount: amount.toString(),
            newBalance: newBalance.toString(),
          });
        } else {
          newBalance = currentBalance.minus(amount);
          this.logDebug('Subtracting transaction amount from holding balance', {
            transactionId: transaction.id,
            currentBalance: currentBalance.toString(),
            amount: amount.toString(),
            newBalance: newBalance.toString(),
          });

          // Check for negative balance
          if (newBalance.isNegative()) {
            this.logWarning('Transaction would result in negative balance', {
              transactionId: transaction.id,
              holdingId: holding.id,
              currentBalance: currentBalance.toString(),
              amount: amount.toString(),
              newBalance: newBalance.toString(),
            });
            // Don't block the transaction, but log the warning
            // In production, you might want to enforce this or alert
          }
        }

        // Update the holding balance
        await this.holdingRepository.update(
          holding.id,
          {
            balance: newBalance.toString(),
            lastUpdated: new Date(),
          },
          tx
        );

        this.logInfo('Transaction created and balance updated', {
          transactionId: transaction.id,
          holdingId: holding.id,
          type: transactionType.code,
          oldBalance: currentBalance.toString(),
          newBalance: newBalance.toString(),
        });

        return transaction;
      });
    } catch (error) {
      throw this.handleError(error, 'execute');
    }
  }

  /**
   * Determine if a transaction type adds to the balance
   *
   * @param typeCode - Transaction type code
   * @returns True if additive, false if subtractive
   */
  private isAdditiveTransactionType(typeCode: string): boolean {
    const additiveTypes = [
      'deposit',
      'buy',
      'receive',
      'airdrop',
      'interest',
      'reward',
      'opening_balance',
    ];

    return additiveTypes.includes(typeCode);
  }

  /**
   * Attempt to fetch and cache the current token price (non-blocking)
   * This is useful for portfolio valuation and historical tracking
   *
   * @param holdingId - The holding to fetch price for
   * @param baseCurrencySymbol - The base currency to price against
   * @param timestamp - The timestamp for the price
   */
  async fetchTokenPrice(
    holdingId: string,
    userId: string,
    baseCurrencySymbol: string,
    _timestamp: Date
  ): Promise<void> {
    try {
      const holding = await this.holdingRepository.findWithDetails(holdingId, userId);

      if (!holding) {
        this.logWarning('Cannot fetch price: holding not found', { holdingId });
        return;
      }

      // Don't fetch price if token is the same as base currency
      if (holding.tokenSymbol === baseCurrencySymbol) {
        return;
      }

      this.logDebug('Price fetching not implemented for this holding type', {
        holdingId,
        tokenSymbol: holding.tokenSymbol,
        baseCurrency: baseCurrencySymbol,
      });
    } catch (error) {
      // Price fetching is non-blocking - log but don't throw
      this.logWarning('Failed to fetch token price', {
        holdingId,
        baseCurrencySymbol,
        error,
      });
    }
  }
}
