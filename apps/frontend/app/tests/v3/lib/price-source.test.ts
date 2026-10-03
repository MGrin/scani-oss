import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import { priceSourceLabel } from '../../../src/v3/lib/price-source';

/**
 * A price's source, named for a person (SC-1527).
 *
 * Measured as a new user: the holding peek printed `frankfurter`,
 * `frankfurter_historical` and `coingecko` under the price — the pricing
 * service's internal keys, suffix and all. A source is shown so the reader can
 * judge the figure; an identifier they have never seen judges nothing.
 */

const t = i18n.t.bind(i18n);

describe('priceSourceLabel', () => {
  test('the providers a new user meets first have their own names', () => {
    expect(priceSourceLabel(t, 'coingecko')).toBe('CoinGecko');
    expect(priceSourceLabel(t, 'frankfurter')).toBe('Frankfurter (ECB rates)');
  });

  test("a variant of a provider's price is still that provider", () => {
    expect(priceSourceLabel(t, 'frankfurter_historical')).toBe('Frankfurter (ECB rates)');
    expect(priceSourceLabel(t, 'coingecko_historical_usd_converted')).toBe('CoinGecko');
    expect(priceSourceLabel(t, 'yahoo-finance_fx_historical')).toBe('Yahoo Finance');
    expect(priceSourceLabel(t, 'kraken_klines_usd')).toBe('Kraken');
    expect(priceSourceLabel(t, 'defillama_stale_fallback')).toBe('DefiLlama');
  });

  test('the prices nobody fetched say whose they are', () => {
    expect(priceSourceLabel(t, 'manual')).toBe('Set manually');
    expect(priceSourceLabel(t, 'base-currency')).toBe('Your base currency');
  });

  test('an unknown id reads as words, never as the raw snake_case id', () => {
    const label = priceSourceLabel(t, 'acme_prices_historical');
    expect(label).toBe('Acme');
    expect(label).not.toContain('_');
    expect(priceSourceLabel(t, 'some-new-feed')).toBe('Some new feed');
  });
});
