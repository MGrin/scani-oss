import { Decimal } from 'decimal.js';
import { eq } from 'drizzle-orm';

import { db } from '../db/connection';
import * as schema from '../db/schema';

export class BalanceCalculationService {
  /**
   * Recalculate holding balance based on all its transactions
   */
  async recalculateHoldingBalance(holdingId: string): Promise<string> {
    // Get all transactions for this holding
    const transactions = await db
      .select({
        id: schema.transactions.id,
        typeId: schema.transactions.typeId,
        type: schema.transactionTypes.code,
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

      switch (transaction.type) {
        // Transactions that increase balance
        case 'buy':
        case 'deposit':
        case 'dividend':
        case 'interest':
        case 'split': // Stock splits increase the number of shares
          balance = balance.plus(amount);
          break;

        // Transactions that decrease balance
        case 'sell':
        case 'withdrawal':
        case 'fee':
        case 'merge': // Stock merges decrease the number of shares
          balance = balance.minus(amount);
          break;

        // Transfer should be handled at the holding level
        // This assumes 'transfer' transactions are recorded on both sides
        case 'transfer':
          // For transfers, the amount could be positive (incoming) or negative (outgoing)
          // The sign of the amount should indicate the direction
          balance = balance.plus(amount);
          break;

        default:
          // For unknown transaction types, assume they follow the sign of the amount
          balance = balance.plus(amount);
          break;
      }

      // Subtract fees (fees are always a cost and reduce balance)
      balance = balance.minus(fee);
    }

    // Ensure balance doesn't go below 0 (optional, depending on business rules)
    if (balance.isNegative()) {
      balance = new Decimal(0);
    }

    return balance.toString();
  }

  /**
   * Update holding balance in database after recalculating
   */
  async updateHoldingBalance(holdingId: string): Promise<void> {
    const newBalance = await this.recalculateHoldingBalance(holdingId);

    await db
      .update(schema.holdings)
      .set({
        balance: newBalance,
        lastUpdated: new Date(),
      })
      .where(eq(schema.holdings.id, holdingId));
  }

  /**
   * Recalculate balances for all holdings in an account
   */
  async recalculateAccountHoldingsBalances(accountId: string): Promise<void> {
    const holdings = await db
      .select({ id: schema.holdings.id })
      .from(schema.holdings)
      .where(eq(schema.holdings.accountId, accountId));

    for (const holding of holdings) {
      await this.updateHoldingBalance(holding.id);
    }
  }

  /**
   * Recalculate balances for all holdings belonging to a user's accounts
   */
  async recalculateUserHoldingsBalances(userId: string): Promise<void> {
    const holdings = await db
      .select({ id: schema.holdings.id })
      .from(schema.holdings)
      .where(eq(schema.holdings.userId, userId));

    for (const holding of holdings) {
      await this.updateHoldingBalance(holding.id);
    }
  }
}
