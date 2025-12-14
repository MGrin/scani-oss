import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import pino from 'pino';
import { getDb } from '../database/connection';
import type * as schema from '../database/schema';

/**
 * Base Service Class
 *
 * Provides common utilities for all service classes including:
 * - Logging infrastructure
 * - Transaction management helpers
 * - Error handling utilities
 * - Common validation patterns
 */
export abstract class BaseService {
  protected readonly logger: pino.Logger;

  constructor(serviceName: string) {
    this.logger = pino({
      name: serviceName,
      level: process.env.LOG_LEVEL || 'info',
      serializers: {
        error: pino.stdSerializers.err,
      },
    });
  }

  /**
   * Execute a function within a database transaction.
   * If an error occurs, the transaction is rolled back.
   *
   * @param callback - Function to execute within the transaction
   * @returns Result of the callback function
   * @throws Error if transaction fails
   */
  protected async withTransaction<T>(
    callback: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>
  ): Promise<T> {
    const db = getDb();

    try {
      this.logger.debug('Starting database transaction');

      const result = await db.transaction(async (tx) => {
        return await callback(tx as unknown as PostgresJsDatabase<typeof schema>);
      });

      this.logger.debug('Transaction completed successfully');
      return result;
    } catch (error) {
      this.logger.error({ error }, 'Transaction failed and was rolled back');
      throw error;
    }
  }

  /**
   * Validate that required fields are present in an object
   *
   * @param data - Object to validate
   * @param requiredFields - Array of field names that must be present
   * @throws Error if any required field is missing
   */
  protected validateRequiredFields<T extends Record<string, unknown>>(
    data: T,
    requiredFields: (keyof T)[]
  ): void {
    const missingFields = requiredFields.filter(
      (field) => data[field] === undefined || data[field] === null
    );

    if (missingFields.length > 0) {
      const error = new Error(`Missing required fields: ${missingFields.join(', ')}`);
      this.logger.error({ missingFields, data }, 'Validation failed: missing required fields');
      throw error;
    }
  }

  /**
   * Handle and normalize errors for consistent error responses
   *
   * @param error - The error to handle
   * @param context - Additional context about where the error occurred
   * @returns Normalized error object
   */
  protected handleError(error: unknown, context: string): Error {
    if (error instanceof Error) {
      this.logger.error({ error, context }, `Error in ${context}`);
      return error;
    }

    const unknownError = new Error(`Unknown error in ${context}: ${String(error)}`);
    this.logger.error({ error, context }, `Unknown error in ${context}`);
    return unknownError;
  }

  /**
   * Log a warning message with context
   *
   * @param message - Warning message
   * @param context - Additional context data
   */
  protected logWarning(message: string, context?: Record<string, unknown>): void {
    this.logger.warn(context, message);
  }

  /**
   * Log an info message with context
   *
   * @param message - Info message
   * @param context - Additional context data
   */
  protected logInfo(message: string, context?: Record<string, unknown>): void {
    this.logger.info(context, message);
  }

  /**
   * Log a debug message with context
   *
   * @param message - Debug message
   * @param context - Additional context data
   */
  protected logDebug(message: string, context?: Record<string, unknown>): void {
    this.logger.debug(context, message);
  }

  /**
   * Log an error message with context
   *
   * @param message - Error message
   * @param context - Additional context data
   */
  protected logError(message: string, context?: Record<string, unknown>): void {
    this.logger.error(context, message);
  }

  /**
   * Validate that a string is not empty
   *
   * @param value - String to validate
   * @param fieldName - Name of the field being validated
   * @throws Error if string is empty or only whitespace
   */
  protected validateNonEmptyString(value: string, fieldName: string): void {
    if (!value || value.trim().length === 0) {
      const error = new Error(`${fieldName} cannot be empty`);
      this.logger.error({ fieldName, value }, `Empty ${fieldName} provided`);
      throw error;
    }
  }

  /**
   * Check if a value exists, throwing an error if it doesn't
   *
   * @param value - Value to check
   * @param errorMessage - Error message if value doesn't exist
   * @throws Error if value is null or undefined
   */
  protected assertExists<T>(value: T | null | undefined, errorMessage: string): asserts value is T {
    if (value === null || value === undefined) {
      const error = new Error(errorMessage);
      this.logger.error({ errorMessage }, 'Assertion failed: value does not exist');
      throw error;
    }
  }

  /**
   * Retry a function with exponential backoff
   *
   * @param fn - Function to retry
   * @param maxRetries - Maximum number of retry attempts
   * @param baseDelay - Base delay in milliseconds (will be doubled each retry)
   * @returns Result of the function
   * @throws Error if all retries fail
   */
  protected async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries = 3,
    baseDelay = 1000
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries) {
          const delay = baseDelay * 2 ** attempt;
          this.logger.warn(
            { attempt, maxRetries, delay, error: lastError },
            `Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    this.logger.error({ maxRetries, error: lastError }, 'All retry attempts failed');
    throw lastError || new Error('Operation failed after retries');
  }
}
