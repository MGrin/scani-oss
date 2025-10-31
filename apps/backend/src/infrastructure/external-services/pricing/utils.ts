export const DEFAULT_FETCH_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_RETRIES = 2;

/**
 * HIGH PRIORITY FIX: Enhanced fetch with timeout and retry logic
 *
 * Features:
 * - Timeout protection (prevents hanging requests)
 * - Exponential backoff retry for transient failures
 * - Respects 429 (rate limit) and 5xx (server error) responses
 * - Does not retry 4xx client errors (except 429)
 * - Enhanced error messages with URL and attempt context
 */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  maxRetries: number = DEFAULT_MAX_RETRIES
): Promise<Response> {
  let lastError: Error | null = null;

  // Validate URL format to catch typos early
  try {
    new URL(url);
  } catch (_urlError) {
    throw new Error(`Invalid URL format: ${url}. Check for typos in the URL or port number.`);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Setup timeout
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<Response>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Request timeout after ${timeoutMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`
              )
            ),
          timeoutMs
        );
      });
      const fetchPromise = fetch(url, init);

      let response: Response;
      try {
        response = (await Promise.race([fetchPromise, timeoutPromise])) as Response;
      } finally {
        if (timer) clearTimeout(timer);
      }

      // Check if response indicates we should retry
      if (attempt < maxRetries && shouldRetry(response)) {
        lastError = new Error(
          `HTTP ${response.status}: ${response.statusText} (attempt ${attempt + 1}/${maxRetries + 1})`
        );

        // Exponential backoff: 1s, 2s, 4s...
        const backoffMs = 2 ** attempt * 1000;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Enhance error message with URL context for debugging
      const enhancedError = new Error(
        `${lastError.message} - URL: ${url} (attempt ${attempt + 1}/${maxRetries + 1})`
      );
      enhancedError.name = lastError.name;
      enhancedError.stack = lastError.stack;
      lastError = enhancedError;

      // Network errors and timeouts are retryable
      if (attempt < maxRetries && isRetryableError(lastError)) {
        // Exponential backoff
        const backoffMs = 2 ** attempt * 1000;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      // Max retries exceeded or non-retryable error
      throw lastError;
    }
  }

  throw lastError || new Error(`Max retries (${maxRetries}) exceeded for URL: ${url}`);
}

/**
 * Determines if an HTTP response should be retried
 */
function shouldRetry(response: Response): boolean {
  // Retry on rate limit
  if (response.status === 429) return true;

  // Retry on server errors (5xx)
  if (response.status >= 500 && response.status < 600) return true;

  // Don't retry other status codes
  return false;
}

/**
 * Determines if an error is retryable (network errors, timeouts)
 */
function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();

  // Timeout errors
  if (message.includes('timeout')) return true;

  // Network connectivity errors
  if (message.includes('network')) return true;
  if (message.includes('econnreset')) return true;
  if (message.includes('enotfound')) return true;
  if (message.includes('connection')) return true;
  if (message.includes('unable to connect')) return true;
  if (message.includes('could not connect')) return true;

  // DNS and host resolution errors
  if (message.includes('getaddrinfo')) return true;
  if (message.includes('etimedout')) return true;

  // Socket errors
  if (message.includes('socket')) return true;
  if (message.includes('econnrefused')) return true;

  return false;
}

export function parseInternationalNumber(value: string | null | undefined): number | null {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const cleaned = value.trim();

  if (!cleaned) {
    return null;
  }

  let parsed = Number(cleaned);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }

  const europeanFormat = cleaned.replace(',', '.');
  parsed = Number(europeanFormat);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }

  return null;
}

export function isValidPrice(value: string | null | undefined): boolean {
  const parsed = parseInternationalNumber(value);
  return parsed !== null && parsed > 0;
}

export function sanitizeForGoogleFinanceSymbol(symbol: string): string {
  if (!symbol) return '';
  const upper = symbol.toString().toUpperCase().trim();
  const sanitized = upper.replace(/[^A-Z0-9.\-:]/g, '');
  return sanitized.slice(0, 32);
}

export function normalizeForFinnhubSymbol(raw: string): string {
  if (!raw) return '';
  let s = raw.toUpperCase().trim();
  s = s.replace(
    /^(NASDAQGS:|NASDAQCM:|NASDAQ:|NYSEARCA:|NYSEAMERICAN:|NYSEMKT:|NYSE:|ARCA:|BATS:)/,
    ''
  );
  s = s.replace(/(:US|\.US)$/i, '');
  s = s.replace(/[^A-Z0-9.-]/g, '');
  return s;
}

export class RateLimiter {
  private requestQueue: Array<() => void> = [];
  private requestTimes: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private isProcessing = false;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

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
