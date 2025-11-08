/**
 * RateLimiter - A queue-based rate limiter for API calls
 *
 * This rate limiter ensures API calls don't exceed specified limits by:
 * - Queueing requests that would exceed the rate limit
 * - Processing requests in batches when slots are available
 * - Tracking request timestamps within a sliding window
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter(50, 60 * 1000); // 50 requests per minute
 * const result = await limiter.execute(() => fetch('https://api.example.com'));
 * ```
 */
export class RateLimiter {
  private requestQueue: Array<() => void> = [];
  private requestTimes: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private isProcessing = false;

  /**
   * Create a new rate limiter
   * @param maxRequests - Maximum number of requests allowed within the time window
   * @param windowMs - Time window in milliseconds
   */
  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Execute a function with rate limiting
   * @param fn - The async function to execute
   * @returns Promise that resolves with the function's result
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.isProcessing || this.requestQueue.length === 0) return;

    this.isProcessing = true;

    const now = Date.now();

    // Remove expired request timestamps
    this.requestTimes = this.requestTimes.filter((time) => now - time < this.windowMs);

    // Calculate how many requests we can process in parallel
    const availableSlots = this.maxRequests - this.requestTimes.length;

    if (availableSlots > 0) {
      // Process multiple requests in parallel (batch processing)
      const batchSize = Math.min(availableSlots, this.requestQueue.length);
      const batch: Array<() => void> = [];

      for (let i = 0; i < batchSize; i++) {
        const nextRequest = this.requestQueue.shift();
        if (nextRequest) {
          batch.push(nextRequest);
          this.requestTimes.push(now);
        }
      }

      // Execute batch in parallel
      for (const request of batch) {
        request();
      }

      // Continue processing queue after a short delay
      this.isProcessing = false;
      setTimeout(() => this.processQueue(), 0);
    } else {
      // Need to wait before processing more requests
      const oldestRequest = this.requestTimes[0];
      if (oldestRequest) {
        const waitTime = this.windowMs - (now - oldestRequest) + 100;
        this.isProcessing = false;
        setTimeout(() => this.processQueue(), waitTime);
      } else {
        this.isProcessing = false;
      }
    }
  }
}

/**
 * Rate limiter interface type for dependency injection
 */
export type IRateLimiter = {
  execute<T>(fn: () => Promise<T>): Promise<T>;
};
