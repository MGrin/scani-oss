/**
 * Stand-alone currency converter for the GoogleSheetsProvider.
 *
 * GoogleSheetsProvider needs to translate prices from per-token native
 * currencies (an LSE-listed stock returns GBP) into the user's base
 * currency. The provider lives in its own workspace and can't reach
 * back into `@scani/domain` (wrong dependency direction), so the
 * conversion runs locally: exchangerate-api.com upstream, in-memory
 * cache, one HTTP round-trip per pair per `CONVERSION_TTL_MS` window.
 * PricingService keeps its own cache for the rest of the pricing path.
 */

import type { OutflowRateLimiter } from '@scani/rate-limiter';
import Decimal from 'decimal.js';

// `https://api.exchangerate-api.com/v4/latest/{base}` — the `/latest/`
// segment is required; the previous `/v4/{base}` form silently 404'd
// in production, leaving every non-USD-quoted holding (UK `.L`, Toronto
// `.TO`, Tokyo `.T`, etc.) stranded with `price='0'` because every
// conversion call returned `'0'` and got cached for 10min.
const EXCHANGERATE_BASE_URL = 'https://api.exchangerate-api.com/v4/latest';
const EXCHANGERATE_FETCH_TIMEOUT_MS = 8000;
const CONVERSION_TTL_MS = 10 * 60 * 1000;

interface CachedRate {
  rate: string;
  expiresAt: number;
}

export class GoogleSheetsCurrencyConverter {
  private readonly cache = new Map<string, CachedRate>();

  constructor(private readonly limiter: OutflowRateLimiter) {}

  async convert(
    price: string,
    fromCurrency: string,
    toCurrency: string,
    _at: Date
  ): Promise<string> {
    if (fromCurrency === toCurrency || price === '0') return price;
    try {
      const rate = await this.getRate(fromCurrency, toCurrency);
      if (rate === '0') return '0';
      return new Decimal(price).mul(new Decimal(rate)).toString();
    } catch {
      return '0';
    }
  }

  private async getRate(fromCurrency: string, toCurrency: string): Promise<string> {
    const key = `${fromCurrency.toUpperCase()}->${toCurrency.toUpperCase()}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.rate;

    const url = `${EXCHANGERATE_BASE_URL}/${fromCurrency}`;
    const response = await this.limiter.execute(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), EXCHANGERATE_FETCH_TIMEOUT_MS);
      try {
        return await fetch(url, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
    });
    if (!response.ok) {
      this.cache.set(key, { rate: '0', expiresAt: Date.now() + CONVERSION_TTL_MS });
      return '0';
    }
    const data = (await response.json()) as { rates?: Record<string, number> };
    const raw = data.rates?.[toCurrency];
    if (typeof raw !== 'number' || raw <= 0) {
      this.cache.set(key, { rate: '0', expiresAt: Date.now() + CONVERSION_TTL_MS });
      return '0';
    }
    const rate = raw.toString();
    this.cache.set(key, { rate, expiresAt: Date.now() + CONVERSION_TTL_MS });
    return rate;
  }
}
