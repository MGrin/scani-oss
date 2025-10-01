export const DEFAULT_FETCH_TIMEOUT_MS = 8000;

export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<Response>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Fetch timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  const fetchPromise = fetch(url, init);

  try {
    const result = (await Promise.race([fetchPromise, timeoutPromise])) as Response;
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
