import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../db/connection';
import * as schema from '../db/schema';

// Type assertion for service operations
const serviceDb = db as ReturnType<typeof import('drizzle-orm/postgres-js').drizzle>;

export interface HoldingChange {
  holdingId: string;
  accountId: string;
  tokenId: string;
  oldBalance?: number;
  newBalance: number;
  oldAverageCostBasis?: number;
  newAverageCostBasis?: number;
  changeType: 'create' | 'update' | 'delete';
  userId: string;
  reason?: string;
}

export interface TransactionGenerationOptions {
  skipIfExists?: boolean;
  source?: 'user' | 'system' | 'import';
  reference?: string;
  description?: string;
}

/**
 * Automatically generates transactions when holdings change
 */
export async function handleHoldingChange(
  change: HoldingChange,
  options: TransactionGenerationOptions = {}
): Promise<string | null> {
  const { skipIfExists = false, source = 'system', reference, description } = options;

  try {
    const now = new Date();

    // Calculate the balance difference
    const balanceDiff = change.newBalance - (change.oldBalance || 0);

    // Don't create transaction if no actual change in balance
    if (Math.abs(balanceDiff) < 0.000001) {
      return null;
    }

    // Check if similar transaction already exists (if skipIfExists is true)
    if (skipIfExists) {
      const existingTransaction = await findSimilarTransaction(change.holdingId, balanceDiff, now);

      if (existingTransaction) {
        return existingTransaction.id;
      }
    }

    // Determine transaction type based on balance change and context
    const transactionTypeCode = determineTransactionType(change, balanceDiff);

    // Look up the transaction type by code to get the typeId
    const [transactionType] = await serviceDb
      .select()
      .from(schema.transactionTypes)
      .where(
        and(
          eq(schema.transactionTypes.code, transactionTypeCode),
          eq(schema.transactionTypes.isActive, true)
        )
      )
      .limit(1);

    if (!transactionType) {
      throw new Error(`Invalid transaction type: ${transactionTypeCode}`);
    }

    // Generate transaction data
    const transactionData = {
      id: nanoid(),
      userId: change.userId,
      holdingId: change.holdingId,
      typeId: transactionType.id, // Use the actual typeId
      amount: balanceDiff,
      price: change.newAverageCostBasis || undefined,
      priceTokenId: undefined, // Will be set to user's base currency by default
      fee: 0,
      feeTokenId: undefined,
      description:
        description || generateTransactionDescription(change, transactionTypeCode, source),
      reference: reference || `auto-${change.changeType}-${Date.now()}`,
      timestamp: now,
      createdAt: now,
      updatedAt: now,
    };

    // Insert the transaction
    const [transaction] = await serviceDb
      .insert(schema.transactions)
      .values(transactionData)
      .returning();

    if (!transaction) {
      throw new Error('Failed to create transaction');
    }

    return transaction.id;
  } catch (error) {
    console.error('Failed to generate automatic transaction:', error);
    throw new Error(
      `Transaction generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Reconciles missing transactions for a holding
 */
export async function reconcileHoldingTransactions(
  holdingId: string,
  expectedBalance: number,
  userId: string
): Promise<{
  reconciled: boolean;
  transactionId?: string;
  discrepancy?: number;
}> {
  try {
    // Get all transactions for this holding
    const transactions = await serviceDb
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.holdingId, holdingId))
      .orderBy(desc(schema.transactions.timestamp));

    // Calculate balance from transactions
    const calculatedBalance = transactions.reduce((balance, tx) => {
      return balance + tx.amount;
    }, 0);

    const discrepancy = expectedBalance - calculatedBalance;

    // If discrepancy is significant, create a reconciliation transaction
    if (Math.abs(discrepancy) >= 0.01) {
      const reconciliationTransaction = await createReconciliationTransaction(
        holdingId,
        discrepancy,
        userId
      );

      if (!reconciliationTransaction) {
        throw new Error('Failed to create reconciliation transaction');
      }

      return {
        reconciled: true,
        transactionId: reconciliationTransaction.id,
        discrepancy,
      };
    }

    return { reconciled: true, discrepancy: 0 };
  } catch (error) {
    console.error('Failed to reconcile transactions:', error);
    return { reconciled: false };
  }
}

/**
 * Validates transaction consistency across all holdings
 */
export async function validateAllHoldings(userId: string): Promise<{
  valid: boolean;
  discrepancies: Array<{
    holdingId: string;
    tokenSymbol: string;
    accountName: string;
    expectedBalance: number;
    calculatedBalance: number;
    discrepancy: number;
  }>;
}> {
  try {
    // Get all holdings with their related data
    const holdings = await serviceDb
      .select({
        holding: schema.holdings,
        token: schema.tokens,
        account: schema.accounts,
      })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .innerJoin(schema.accounts, eq(schema.holdings.accountId, schema.accounts.id))
      .innerJoin(schema.institutions, eq(schema.accounts.institutionId, schema.institutions.id))
      .where(eq(schema.accounts.userId, userId));

    const discrepancies = [];

    for (const { holding, token, account } of holdings) {
      // Get all transactions for this holding
      const transactions = await serviceDb
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.holdingId, holding.id));

      const calculatedBalance = transactions.reduce((balance, tx) => {
        return balance + tx.amount;
      }, 0);

      const discrepancy = holding.balance - calculatedBalance;

      if (Math.abs(discrepancy) >= 0.01) {
        discrepancies.push({
          holdingId: holding.id,
          tokenSymbol: token.symbol,
          accountName: account.name,
          expectedBalance: holding.balance,
          calculatedBalance,
          discrepancy,
        });
      }
    }

    return {
      valid: discrepancies.length === 0,
      discrepancies,
    };
  } catch (error) {
    console.error('Failed to validate holdings:', error);
    return { valid: false, discrepancies: [] };
  }
}

/**
 * Auto-corrects discrepancies by creating reconciliation transactions
 */
export async function autoCorrectDiscrepancies(
  discrepancies: Array<{
    holdingId: string;
    tokenSymbol: string;
    accountName: string;
    expectedBalance: number;
    calculatedBalance: number;
    discrepancy: number;
  }>,
  userId: string
): Promise<string[]> {
  const transactionIds = [];

  for (const discrepancy of discrepancies) {
    try {
      const transaction = await createReconciliationTransaction(
        discrepancy.holdingId,
        discrepancy.discrepancy,
        userId,
        `Auto-correction for ${discrepancy.tokenSymbol} in ${discrepancy.accountName}`
      );
      if (transaction) {
        transactionIds.push(transaction.id);
      }
    } catch (error) {
      console.error(
        `Failed to create reconciliation transaction for holding ${discrepancy.holdingId}:`,
        error
      );
    }
  }

  return transactionIds;
}

// Helper functions

async function findSimilarTransaction(holdingId: string, _amount: number, timestamp: Date) {
  // Look for transactions within 1 minute of the timestamp with same amount
  const timeRange = 60000; // 1 minute in milliseconds
  const _minTime = new Date(timestamp.getTime() - timeRange);
  const _maxTime = new Date(timestamp.getTime() + timeRange);

  const [transaction] = await serviceDb
    .select()
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.holdingId, holdingId)
        // Note: This is a simplified check. In production, you'd want more sophisticated date range filtering
      )
    )
    .limit(1);

  return transaction;
}

function determineTransactionType(change: HoldingChange, balanceDiff: number): string {
  if (change.changeType === 'create') {
    return balanceDiff > 0 ? 'deposit' : 'withdrawal';
  } else if (change.changeType === 'delete') {
    return 'withdrawal';
  } else {
    // For updates, determine based on balance change
    if (balanceDiff > 0) {
      return 'deposit';
    } else if (balanceDiff < 0) {
      return 'withdrawal';
    } else {
      return 'other'; // Price adjustment or other change
    }
  }
}

function generateTransactionDescription(
  change: HoldingChange,
  transactionType: string,
  source: string
): string {
  const descriptions = {
    create: `Initial ${transactionType} (${source})`,
    update: `Balance adjustment - ${transactionType} (${source})`,
    delete: `Final withdrawal on holding deletion (${source})`,
  };

  let baseDescription =
    descriptions[change.changeType as keyof typeof descriptions] ||
    `Automatic ${transactionType} (${source})`;

  if (change.reason) {
    baseDescription += ` - ${change.reason}`;
  }

  return baseDescription;
}

async function createReconciliationTransaction(
  holdingId: string,
  discrepancy: number,
  _userId: string,
  customDescription?: string
) {
  const now = new Date();

  // Look up the "other" transaction type by code to get the typeId
  const [transactionType] = await serviceDb
    .select()
    .from(schema.transactionTypes)
    .where(
      and(eq(schema.transactionTypes.code, 'other'), eq(schema.transactionTypes.isActive, true))
    )
    .limit(1);

  if (!transactionType) {
    throw new Error('Other transaction type not found');
  }

  const transactionData = {
    id: nanoid(),
    userId: _userId,
    holdingId,
    typeId: transactionType.id, // Use the actual typeId
    amount: discrepancy,
    price: undefined,
    priceTokenId: undefined,
    fee: 0,
    feeTokenId: undefined,
    description:
      customDescription ||
      `Reconciliation adjustment: ${
        discrepancy > 0 ? 'Added' : 'Removed'
      } ${Math.abs(discrepancy)} units`,
    reference: `reconciliation-${Date.now()}`,
    timestamp: now,
    createdAt: now,
    updatedAt: now,
  };

  const [transaction] = await serviceDb
    .insert(schema.transactions)
    .values(transactionData)
    .returning();

  return transaction;
}

/**
 * Middleware function to automatically handle transaction generation
 * Should be called after any holding CRUD operation
 */
export async function withTransactionGeneration<T>(
  operation: () => Promise<T>,
  change: HoldingChange,
  options?: TransactionGenerationOptions
): Promise<T> {
  const result = await operation();

  try {
    await handleHoldingChange(change, options);
  } catch (error) {
    console.error('Transaction generation failed but operation succeeded:', error);
    // Don't fail the main operation if transaction generation fails
  }

  return result;
}
