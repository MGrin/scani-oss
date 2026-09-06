import { describe, expect, test } from 'bun:test';
import { filterProvidersByTokenType } from '../../../src/services/pricing/HistoricalPriceBackfillService';
import {
  hasExternalPricingAuthority,
  TOKEN_TYPE_TO_PROVIDER,
} from '../../../src/services/pricing/token-type-pricing';

/**
 * SC-1115 — the guard, not the fix.
 *
 * Two places in this codebase answered "may an external provider price this
 * token type": `PricingProviderRouter`'s table and the historical backfill's
 * `filterProvidersByTokenType`. They disagreed about `private-company` for as
 * long as both existed, and the disagreement was invisible because neither
 * mentions the other and the filter never named the type at all.
 *
 * They read one table now. What this file pins is that they cannot stop
 * agreeing — a test on the private-company arm alone would pass again the day
 * somebody adds a sixth type and answers it in only one place.
 */

const PROVIDERS = [
  { providerKey: 'yahoo-finance' },
  { providerKey: 'finnhub' },
  { providerKey: 'defillama' },
  { providerKey: 'coingecko' },
  { providerKey: 'kraken' },
  { providerKey: 'binance' },
];

describe('the backfill filter and the pricing router agree on every token type', () => {
  for (const [typeCode, provider] of Object.entries(TOKEN_TYPE_TO_PROVIDER)) {
    const routerWouldPrice = provider !== null;

    test(`${typeCode}: router ${routerWouldPrice ? 'prices' : 'refuses'}, so the backfill does too`, () => {
      expect(hasExternalPricingAuthority(typeCode)).toBe(routerWouldPrice);
      expect(filterProvidersByTokenType(PROVIDERS, typeCode).length > 0).toBe(routerWouldPrice);
    });
  }

  /**
   * The control. Every assertion above is a `toBe` against a value read off
   * the same table, so a table with one entry — or five entries all `null` —
   * would satisfy the loop while proving nothing about the disagreement this
   * file exists to prevent. Both outcomes must be present in the table for the
   * loop to have covered both directions.
   */
  test('the table exercises both answers', () => {
    const answers = Object.values(TOKEN_TYPE_TO_PROVIDER);
    expect(answers.filter((p) => p === null).length).toBeGreaterThan(0);
    expect(answers.filter((p) => p !== null).length).toBeGreaterThan(0);
  });

  test('a type absent from the table is refused rather than defaulted', () => {
    expect(TOKEN_TYPE_TO_PROVIDER['not-a-real-token-type']).toBeUndefined();
    expect(hasExternalPricingAuthority('not-a-real-token-type')).toBe(false);
    expect(hasExternalPricingAuthority(null)).toBe(false);
    expect(hasExternalPricingAuthority(undefined)).toBe(false);
  });

  test('the lookup is case-insensitive, as the router reads it', () => {
    expect(hasExternalPricingAuthority('CRYPTO')).toBe(true);
    expect(hasExternalPricingAuthority('Private-Company')).toBe(false);
  });
});
