/**
 * Stand-alone currency converter for the GoogleSheetsProvider.
 *
 * GoogleSheetsProvider needs to translate prices from per-token native
 * currencies (an LSE-listed stock returns GBP) into the user's base
 * currency. The provider lives in its own workspace and can't reach
 * back into `@scani/domain` (wrong dependency direction), so the
 * conversion runs locally, over the process's one exchangerate-api
 * client: its USD table answers every pair, and it owns the cache and
 * the limiter.
 */

import {
  type ExchangeRateApiClient,
  rateBetween,
} from '@scani/providers/providers/exchangerate-api';
import Decimal from 'decimal.js';
import type { ConversionOutcome } from './conversion-outcome';

export class GoogleSheetsCurrencyConverter {
  constructor(private readonly exchangeRates: ExchangeRateApiClient) {}

  async convert(
    price: string,
    fromCurrency: string,
    toCurrency: string,
    _at: Date
  ): Promise<ConversionOutcome> {
    if (fromCurrency === toCurrency) return { ok: true, price };
    const table = await this.exchangeRates.fetchUsdRates();
    const rate = table && rateBetween(table.rates, fromCurrency, toCurrency);
    if (!rate) {
      return {
        ok: false,
        reason: `no ${fromCurrency}->${toCurrency} rate available upstream`,
      };
    }
    try {
      return { ok: true, price: new Decimal(price).mul(rate).toString() };
    } catch {
      return {
        ok: false,
        reason: `the price '${price}' is not a number, so it cannot be expressed in ${toCurrency}`,
      };
    }
  }
}
