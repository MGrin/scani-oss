export type BackoffStrategy = 'exponential' | 'linear' | 'constant';

export async function withRetry<T>(
  fn: () => Promise<T>,
  {
    retries = 3,
    baseDelayMs = 500,
    maxDelayMs = 5000,
    strategy = 'exponential' as BackoffStrategy,
    shouldRetry = () => true,
  }: {
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    strategy?: BackoffStrategy;
    shouldRetry?: (e: unknown, attempt: number) => boolean;
  } = {}
): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt === retries || !shouldRetry(e, attempt)) break;

      const delay = Math.min(
        strategy === 'exponential'
          ? baseDelayMs * 2 ** attempt
          : strategy === 'linear'
            ? baseDelayMs * (attempt + 1)
            : baseDelayMs,
        maxDelayMs
      );
      await new Promise((res) => setTimeout(res, delay));
      attempt += 1;
    }
  }

  throw lastError;
}
