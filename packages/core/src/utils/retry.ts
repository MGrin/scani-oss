/**
 * Retry Utility
 *
 * Provides retry logic with exponential backoff for database operations
 * that may fail due to connection timeouts.
 */

import { createComponentLogger } from './logger';

const logger = createComponentLogger('util:retry');

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in ms before first retry (default: 1000) */
  initialDelay?: number;
  /** Maximum delay in ms between retries (default: 10000) */
  maxDelay?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Function to determine if error is retryable (default: all errors) */
  isRetryable?: (error: unknown) => boolean;
}

/**
 * Default function to check if error is retryable
 * Retries on connection timeouts and temporary database errors
 */
function defaultIsRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('connect_timeout') ||
      message.includes('write connect_timeout') ||
      message.includes('connection timeout') ||
      message.includes('connection timed out') ||
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('etimedout')
    );
  }
  return false;
}

/**
 * Retry a function with exponential backoff
 *
 * @param fn - The async function to retry
 * @param options - Retry configuration options
 * @returns The result of the function if successful
 * @throws The last error if all retries fail
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    backoffMultiplier = 2,
    isRetryable = defaultIsRetryable,
  } = options;

  let lastError: unknown;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry
      if (attempt >= maxAttempts || !isRetryable(error)) {
        throw error;
      }

      // Log retry attempt
      logger.warn(
        {
          attempt,
          maxAttempts,
          delay,
          error: error instanceof Error ? error.message : String(error),
        },
        'Retrying operation after error'
      );

      // Wait before next attempt
      await new Promise((resolve) => setTimeout(resolve, delay));

      // Increase delay for next attempt (exponential backoff)
      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }
  }

  // This line is reached if all retries fail and the last error was non-retryable
  // (thrown in the catch block above)
  throw lastError;
}
