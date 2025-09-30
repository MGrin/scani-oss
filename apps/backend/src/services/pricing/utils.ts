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
    if (this.requestQueue.length === 0) return;

    const now = Date.now();

    this.requestTimes = this.requestTimes.filter((time) => now - time < this.windowMs);

    if (this.requestTimes.length < this.maxRequests) {
      const nextRequest = this.requestQueue.shift();
      if (nextRequest) {
        this.requestTimes.push(now);
        nextRequest();
        setTimeout(() => this.processQueue(), 0);
      }
    } else {
      const oldestRequest = this.requestTimes[0];
      if (oldestRequest) {
        const waitTime = this.windowMs - (now - oldestRequest) + 100;
        setTimeout(() => this.processQueue(), waitTime);
      }
    }
  }
}
