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

/**
 * Map Finnhub/Yahoo-style symbol suffixes to exchange + quoted-currency.
 * Finnhub's free tier only prices US-listed symbols — anything with a
 * non-US suffix needs to route through Google Sheets (GOOGLEFINANCE).
 * The currency is used by the Google Sheets provider to convert the
 * returned price into the user's base currency.
 *
 * US share classes (`BRK.A`, `BF.B`, …) deliberately aren't in this map
 * so they stay on Finnhub.
 */
export const NON_US_EXCHANGE_SUFFIX_MAP: Record<string, { exchange: string; currency: string }> = {
  // Canada
  TO: { exchange: 'TSX', currency: 'CAD' },
  V: { exchange: 'TSXV', currency: 'CAD' },
  NE: { exchange: 'NEO', currency: 'CAD' },
  CN: { exchange: 'CSE', currency: 'CAD' },
  // UK
  L: { exchange: 'LSE', currency: 'GBP' },
  IL: { exchange: 'LSE', currency: 'USD' },
  AQ: { exchange: 'AQSE', currency: 'GBP' },
  // Euronext / continental Europe
  PA: { exchange: 'PAR', currency: 'EUR' },
  AS: { exchange: 'AMS', currency: 'EUR' },
  BR: { exchange: 'BRU', currency: 'EUR' },
  LS: { exchange: 'LIS', currency: 'EUR' },
  MI: { exchange: 'MIL', currency: 'EUR' },
  MC: { exchange: 'MAD', currency: 'EUR' },
  VI: { exchange: 'VIE', currency: 'EUR' },
  DE: { exchange: 'XETRA', currency: 'EUR' },
  F: { exchange: 'FRA', currency: 'EUR' },
  MU: { exchange: 'MUN', currency: 'EUR' },
  BE: { exchange: 'BER', currency: 'EUR' },
  SG: { exchange: 'STU', currency: 'EUR' },
  HM: { exchange: 'HAM', currency: 'EUR' },
  HA: { exchange: 'HAN', currency: 'EUR' },
  HE: { exchange: 'HEL', currency: 'EUR' },
  IR: { exchange: 'ISE', currency: 'EUR' },
  // Nordic / Switzerland
  SW: { exchange: 'SIX', currency: 'CHF' },
  ST: { exchange: 'STO', currency: 'SEK' },
  OL: { exchange: 'OSL', currency: 'NOK' },
  CO: { exchange: 'CPH', currency: 'DKK' },
  IC: { exchange: 'ICE', currency: 'ISK' },
  // Asia
  T: { exchange: 'TYO', currency: 'JPY' },
  HK: { exchange: 'HKG', currency: 'HKD' },
  SS: { exchange: 'SHA', currency: 'CNY' },
  SZ: { exchange: 'SHE', currency: 'CNY' },
  KS: { exchange: 'KRX', currency: 'KRW' },
  KQ: { exchange: 'KOSDAQ', currency: 'KRW' },
  SI: { exchange: 'SGX', currency: 'SGD' },
  BK: { exchange: 'SET', currency: 'THB' },
  TW: { exchange: 'TPE', currency: 'TWD' },
  TWO: { exchange: 'TPEX', currency: 'TWD' },
  JK: { exchange: 'IDX', currency: 'IDR' },
  NS: { exchange: 'NSE', currency: 'INR' },
  BO: { exchange: 'BSE', currency: 'INR' },
  // Pacific
  AX: { exchange: 'ASX', currency: 'AUD' },
  NZ: { exchange: 'NZX', currency: 'NZD' },
  // LatAm
  SA: { exchange: 'B3', currency: 'BRL' },
  MX: { exchange: 'BMV', currency: 'MXN' },
  BA: { exchange: 'BCBA', currency: 'ARS' },
  CL: { exchange: 'BCS', currency: 'CLP' },
  // Africa / MENA
  JO: { exchange: 'JSE', currency: 'ZAR' },
  CA: { exchange: 'EGX', currency: 'EGP' },
  // CIS / CEE / Middle East
  ME: { exchange: 'MOEX', currency: 'RUB' },
  IS: { exchange: 'BIST', currency: 'TRY' },
  WA: { exchange: 'WSE', currency: 'PLN' },
  TA: { exchange: 'TASE', currency: 'ILS' },
  SR: { exchange: 'TADAWUL', currency: 'SAR' },
};

/**
 * Extract exchange + currency info from a Finnhub/Yahoo-style symbol.
 * Returns null for US listings (no suffix, or share-class suffix only).
 */
export function detectFinnhubExchangeInfo(
  symbol: string
): { exchange: string; currency: string } | null {
  if (!symbol) return null;
  const dotIdx = symbol.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const suffix = symbol.slice(dotIdx + 1).toUpperCase();
  return NON_US_EXCHANGE_SUFFIX_MAP[suffix] ?? null;
}

// Re-export RateLimiter from @scani/rate-limiter package
export { type IRateLimiter, RateLimiter } from '@scani/rate-limiter';
