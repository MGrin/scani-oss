import { createComponentLogger } from '../utils/logger';
import { type DbType, db } from './connection';

const txLogger = createComponentLogger('transaction');

// Transaction type that works with Drizzle
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Database transaction type alias
export type DatabaseTransaction = Transaction;

// Database or Transaction type - use this when you need either
export type DbOrTransaction = DbType | Transaction;

// Transaction options
export interface TransactionOptions {
  /**
   * Timeout for the transaction in milliseconds
   * Default: 5000ms (5 seconds)
   */
  timeout?: number;

  /**
   * Name/description for logging purposes
   */
  name?: string;

  /**
   * Whether to log transaction lifecycle events
   * Default: true
   */
  enableLogging?: boolean;
}

/**
 * Execute a function within a database transaction
 *
 * @param fn - Function to execute within transaction
 * @param options - Transaction options
 * @returns Result of the function
 *
 * @example
 * ```typescript
 * const result = await withTransaction(async (tx) => {
 *   const user = await userRepo.create({ email: 'test@example.com' }, tx);
 *   const account = await accountRepo.create({ userId: user.id }, tx);
 *   return { user, account };
 * }, { name: 'createUserWithAccount', timeout: 10000 });
 * ```
 */
export async function withTransaction<T>(
  fn: (tx: Transaction) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const { timeout = 5000, name = 'unnamed-transaction', enableLogging = true } = options;

  const startTime = Date.now();

  if (enableLogging) {
    txLogger.debug({ name, timeout }, '🔄 Transaction starting');
  }

  try {
    // Create a promise that rejects after timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Transaction "${name}" timed out after ${timeout}ms`));
      }, timeout);
    });

    // Race between the transaction and the timeout
    const result = await Promise.race([
      db.transaction(async (tx) => {
        return await fn(tx);
      }),
      timeoutPromise,
    ]);

    const duration = Date.now() - startTime;

    if (enableLogging) {
      txLogger.info({ name, duration: `${duration}ms` }, '✅ Transaction committed');
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    if (enableLogging) {
      txLogger.error(
        {
          name,
          duration: `${duration}ms`,
          error: error instanceof Error ? error.message : String(error),
        },
        '❌ Transaction rolled back'
      );
    }

    throw error;
  }
}

/**
 * Execute multiple operations in a single transaction
 * Useful for coordinating multiple repository operations
 *
 * @example
 * ```typescript
 * await batchTransaction([
 *   (tx) => userRepo.create({ email: 'user1@example.com' }, tx),
 *   (tx) => userRepo.create({ email: 'user2@example.com' }, tx),
 *   (tx) => userRepo.create({ email: 'user3@example.com' }, tx),
 * ], { name: 'batchCreateUsers' });
 * ```
 */
export async function batchTransaction<T>(
  operations: Array<(tx: Transaction) => Promise<T>>,
  options: TransactionOptions = {}
): Promise<T[]> {
  return withTransaction(
    async (tx) => {
      const results: T[] = [];

      for (const operation of operations) {
        const result = await operation(tx);
        results.push(result);
      }

      return results;
    },
    {
      ...options,
      name: options.name || 'batch-transaction',
    }
  );
}

/**
 * Type guard to check if an object is a transaction
 */
export function isTransaction(obj: unknown): obj is Transaction {
  // Check if obj has the basic structure of a Drizzle transaction
  // This is a simple check - may need refinement
  return obj !== null && typeof obj === 'object' && 'query' in obj && 'execute' in obj;
}

/**
 * Helper to get database instance (transaction or regular db)
 * Useful in repositories to accept optional transaction parameter
 *
 * @example
 * ```typescript
 * class UserRepository {
 *   async findById(id: string, tx?: Transaction) {
 *     const database = getDb(tx);
 *     return database.select().from(users).where(eq(users.id, id));
 *   }
 * }
 * ```
 */
export function getDb(transaction?: Transaction): DbOrTransaction {
  return transaction || db;
}
