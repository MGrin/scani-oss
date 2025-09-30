import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { createComponentLogger } from '../utils/logger';
import { userContextService } from './user-context-enhanced';

/**
 * Consolidated holding management service that replaces:
 * - BalanceCalculationService
 * - TransactionAutomationService (transaction creation parts)
 * - Parts of ScreenshotParsingService transaction logic
 *
 * Eliminates redundant balance calculation and transaction creation logic
 */
export class HoldingManagementService {
  private readonly logger = createComponentLogger('holding-management');
  /**
   * Calculate holding balance from transaction history
   * Consolidates multiple implementations from different services
   */
  async calculateHoldingBalance(holdingId: string): Promise<string> {
    // Get all transactions for this holding in a single optimized query
    const transactions = await db
      .select({
        id: schema.transactions.id,
        typeCode: schema.transactionTypes.code,
        amount: schema.transactions.amount,
        fee: schema.transactions.fee,
        timestamp: schema.transactions.timestamp,
      })
      .from(schema.transactions)
      .innerJoin(
        schema.transactionTypes,
        eq(schema.transactions.typeId, schema.transactionTypes.id)
      )
      .where(eq(schema.transactions.holdingId, holdingId))
      .orderBy(schema.transactions.timestamp);

    let balance = new Decimal(0);

    // Process transactions chronologically
    for (const transaction of transactions) {
      const amount = new Decimal(transaction.amount || 0);
      const fee = new Decimal(transaction.fee || 0);

      // Apply transaction based on type
      switch (transaction.typeCode) {
        // Transactions that increase balance
        case 'buy':
        case 'deposit':
        case 'dividend':
        case 'interest':
        case 'split':
          balance = balance.plus(amount);
          break;

        // Transactions that decrease balance
        case 'sell':
        case 'withdrawal':
        case 'fee':
        case 'merge':
          balance = balance.minus(amount);
          break;

        // Transfers use the sign of the amount
        case 'transfer':
          balance = balance.plus(amount);
          break;

        // Other types (including reconciliation)
        default:
          balance = balance.plus(amount);
          break;
      }

      // Subtract fees (always reduce balance)
      balance = balance.minus(fee);
    }

    // Ensure balance doesn't go negative (business rule)
    if (balance.isNegative()) {
      balance = new Decimal(0);
    }

    return balance.toString();
  }

  /**
   * Unified transaction creation method
   * Consolidates all transaction creation logic from multiple services
   */
  async createTransaction(params: TransactionCreationParams): Promise<Transaction> {
    const {
      userId,
      holdingId,
      typeCode,
      amount,
      fee = '0',
      feeTokenId,
      description,
      reference,
      timestamp = new Date(),
    } = params;

    // Get transaction type using cached service
    const transactionType = await userContextService.getTransactionType(typeCode);

    const transactionData = {
      id: nanoid(),
      userId,
      holdingId,
      typeId: transactionType.id,
      amount: amount.toString(),
      fee: fee.toString(),
      feeTokenId,
      description,
      reference: reference || `auto-${typeCode}-${Date.now()}`,
      timestamp,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const [transaction] = await db.insert(schema.transactions).values(transactionData).returning();

    if (!transaction) {
      throw new Error('Failed to create transaction');
    }

    return transaction;
  }

  /**
   * Update holding balance in database after recalculating
   * Consolidates balance update logic
   */
  async updateHoldingBalance(holdingId: string): Promise<string> {
    const newBalance = await this.calculateHoldingBalance(holdingId);

    await db
      .update(schema.holdings)
      .set({
        balance: newBalance,
        lastUpdated: new Date(),
      })
      .where(eq(schema.holdings.id, holdingId));

    return newBalance;
  }

  /**
   * Reconcile holding balance with expected value
   * Consolidates reconciliation logic from TransactionAutomationService
   */
  async reconcileHolding(
    holdingId: string,
    expectedBalance: string,
    userId: string,
    options: ReconciliationOptions = {}
  ): Promise<ReconciliationResult> {
    const { createTransaction: shouldCreateTransaction = true, description } = options;

    try {
      const calculatedBalance = await this.calculateHoldingBalance(holdingId);
      const discrepancy = new Decimal(expectedBalance).sub(new Decimal(calculatedBalance));

      // If discrepancy is negligible, no action needed
      if (discrepancy.abs().lt(0.000001)) {
        return {
          reconciled: true,
          discrepancy: '0',
          calculatedBalance,
          expectedBalance,
        };
      }

      let transactionId: string | undefined;

      // Create reconciliation transaction if requested and discrepancy is significant
      if (shouldCreateTransaction && discrepancy.abs().gte(0.01)) {
        const transaction = await this.createTransaction({
          userId,
          holdingId,
          typeCode: 'other', // Reconciliation transactions use 'other' type
          amount: discrepancy,
          description:
            description ||
            `Reconciliation adjustment: ${
              discrepancy.greaterThan(0) ? 'Added' : 'Removed'
            } ${discrepancy.abs().toString()} units`,
        });

        transactionId = transaction.id;

        // Update holding balance
        await this.updateHoldingBalance(holdingId);
      }

      return {
        reconciled: true,
        discrepancy: discrepancy.toString(),
        calculatedBalance,
        expectedBalance,
        transactionId,
      };
    } catch (error) {
      this.logger.error(
        {
          holdingId,
          expectedBalance,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        'Failed to reconcile holding'
      );
      return {
        reconciled: false,
        discrepancy: '0',
        calculatedBalance: '0',
        expectedBalance,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Batch recalculate balances for multiple holdings
   * Optimizes operations across multiple holdings
   */
  async batchUpdateHoldingBalances(holdingIds: string[]): Promise<Map<string, string>> {
    if (holdingIds.length === 0) return new Map();

    const results = new Map<string, string>();

    // Process in parallel but with controlled concurrency
    const BATCH_SIZE = 10;
    for (let i = 0; i < holdingIds.length; i += BATCH_SIZE) {
      const batch = holdingIds.slice(i, i + BATCH_SIZE);

      const batchPromises = batch.map(async (holdingId) => {
        const newBalance = await this.updateHoldingBalance(holdingId);
        return { holdingId, newBalance };
      });

      const batchResults = await Promise.all(batchPromises);

      for (const { holdingId, newBalance } of batchResults) {
        results.set(holdingId, newBalance);
      }
    }

    return results;
  }

  /**
   * Batch calculate balances for multiple holdings (read-only)
   * Optimizes validation operations that need to check many balances
   */
  async batchCalculateHoldingBalances(holdingIds: string[]): Promise<Map<string, string>> {
    if (holdingIds.length === 0) return new Map();

    const results = new Map<string, string>();

    // Process in parallel but with controlled concurrency
    const BATCH_SIZE = 10;
    for (let i = 0; i < holdingIds.length; i += BATCH_SIZE) {
      const batch = holdingIds.slice(i, i + BATCH_SIZE);

      const batchPromises = batch.map(async (holdingId) => {
        const balance = await this.calculateHoldingBalance(holdingId);
        return { holdingId, balance };
      });

      const batchResults = await Promise.all(batchPromises);

      for (const { holdingId, balance } of batchResults) {
        results.set(holdingId, balance);
      }
    }

    return results;
  }

  /**
   * Recalculate balances for all holdings in an account
   * Optimized version of the scattered account-level operations
   */
  async recalculateAccountHoldingBalances(accountId: string): Promise<Map<string, string>> {
    const holdings = await db
      .select({ id: schema.holdings.id })
      .from(schema.holdings)
      .where(eq(schema.holdings.accountId, accountId));

    const holdingIds = holdings.map((h) => h.id);
    return this.batchUpdateHoldingBalances(holdingIds);
  }

  /**
   * Recalculate balances for all user holdings
   * Optimized version of the user-level operations
   */
  async recalculateUserHoldingBalances(userId: string): Promise<Map<string, string>> {
    const holdings = await db
      .select({ id: schema.holdings.id })
      .from(schema.holdings)
      .where(eq(schema.holdings.userId, userId));

    const holdingIds = holdings.map((h) => h.id);
    return this.batchUpdateHoldingBalances(holdingIds);
  }

  /**
   * Validate transaction consistency across holdings
   * Enhanced version from TransactionAutomationService with better performance
   */
  async validateHoldings(userId: string): Promise<ValidationResult> {
    try {
      // Get all holdings with their related data in a single query
      const holdings = await db
        .select({
          holdingId: schema.holdings.id,
          holdingBalance: schema.holdings.balance,
          tokenSymbol: schema.tokens.symbol,
          accountName: schema.accounts.name,
          institutionName: schema.institutions.name,
        })
        .from(schema.holdings)
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .innerJoin(schema.accounts, eq(schema.holdings.accountId, schema.accounts.id))
        .innerJoin(schema.institutions, eq(schema.accounts.institutionId, schema.institutions.id))
        .where(eq(schema.holdings.userId, userId));

      const discrepancies: HoldingDiscrepancy[] = [];

      // Batch calculate all balances to avoid N+1 queries
      const holdingIds = holdings.map((h) => h.holdingId);
      const calculatedBalances = await this.batchCalculateHoldingBalances(holdingIds);

      // Validate each holding
      for (const holding of holdings) {
        const calculatedBalance = calculatedBalances.get(holding.holdingId) || '0';
        const expectedBalance = new Decimal(holding.holdingBalance);
        const discrepancy = expectedBalance.sub(new Decimal(calculatedBalance));

        if (discrepancy.abs().gte(0.01)) {
          discrepancies.push({
            holdingId: holding.holdingId,
            tokenSymbol: holding.tokenSymbol,
            accountName: holding.accountName,
            institutionName: holding.institutionName,
            expectedBalance: holding.holdingBalance,
            calculatedBalance,
            discrepancy: discrepancy.toString(),
          });
        }
      }

      return {
        valid: discrepancies.length === 0,
        holdingsChecked: holdings.length,
        discrepancies,
      };
    } catch (error) {
      this.logger.error(
        {
          userId,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        'Failed to validate holdings'
      );
      return {
        valid: false,
        holdingsChecked: 0,
        discrepancies: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Auto-correct discrepancies by creating reconciliation transactions
   * Enhanced version with better error handling
   */
  async autoCorrectDiscrepancies(
    discrepancies: HoldingDiscrepancy[],
    userId: string
  ): Promise<string[]> {
    const transactionIds: string[] = [];

    for (const discrepancy of discrepancies) {
      try {
        const result = await this.reconcileHolding(
          discrepancy.holdingId,
          discrepancy.expectedBalance,
          userId,
          {
            description: `Auto-correction for ${discrepancy.tokenSymbol} in ${discrepancy.accountName}`,
          }
        );

        if (result.transactionId) {
          transactionIds.push(result.transactionId);
        }
      } catch (error) {
        this.logger.error(
          {
            holdingId: discrepancy.holdingId,
            userId,
            error: error instanceof Error ? { name: error.name, message: error.message } : error,
          },
          'Failed to auto-correct holding discrepancy'
        );
      }
    }

    return transactionIds;
  }
}

// Types for better type safety
export interface TransactionCreationParams {
  userId: string;
  holdingId: string;
  typeCode: string;
  amount: Decimal | string;
  fee?: Decimal | string;
  feeTokenId?: string;
  description?: string;
  reference?: string;
  timestamp?: Date;
}

export interface ReconciliationOptions {
  createTransaction?: boolean;
  description?: string;
}

export interface ReconciliationResult {
  reconciled: boolean;
  discrepancy: string;
  calculatedBalance: string;
  expectedBalance: string;
  transactionId?: string;
  error?: string;
}

export interface HoldingDiscrepancy {
  holdingId: string;
  tokenSymbol: string;
  accountName: string;
  institutionName: string;
  expectedBalance: string;
  calculatedBalance: string;
  discrepancy: string;
}

export interface ValidationResult {
  valid: boolean;
  holdingsChecked: number;
  discrepancies: HoldingDiscrepancy[];
  error?: string;
}

export interface Transaction {
  id: string;
  userId: string;
  holdingId: string;
  typeId: string;
  amount: string;
  fee: string;
  feeTokenId: string | null;
  description: string | null;
  reference: string | null;
  timestamp: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Singleton instance
export const holdingManagementService = new HoldingManagementService();
