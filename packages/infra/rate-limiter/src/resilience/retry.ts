// Lightweight retry helper for transient external failures.
//
// Use for: network errors, 5xx responses, rate-limit errors from external
// APIs (CoinGecko, Binance, Kraken, blockchain RPCs).
//
// Do NOT use for: database writes, logic errors, validation failures.
//
// The classifier decides whether an error is transient. If the classifier
// returns false, the error is re-thrown immediately without further attempts.

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, error: unknown) => void;
  isTransient?: (error: unknown) => boolean;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 16000;

/**
 * Heuristic default: anything that looks like a network error or a 5xx/429
 * HTTP status is transient. Everything else is not.
 */
export function defaultIsTransient(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  if (
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('etimedout') ||
    message.includes('network') ||
    message.includes('fetch failed') ||
    message.includes('socket hang up') ||
    message.includes('too many requests') ||
    message.includes('rate limit')
  ) {
    return true;
  }

  // HTTP client errors with a numeric status — treat 429 and 5xx as transient.
  const status =
    (error as { status?: number }).status ??
    (error as { statusCode?: number }).statusCode ??
    (error as { response?: { status?: number } }).response?.status;
  if (typeof status === 'number') {
    return status === 429 || (status >= 500 && status < 600);
  }

  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const isTransient = options.isTransient ?? defaultIsTransient;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransient(error)) {
        throw error;
      }
      options.onRetry?.(attempt, error);
      const delay = Math.min(baseDelayMs * 4 ** (attempt - 1), maxDelayMs);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Unreachable — the loop either returns or throws.
  throw lastError;
}
