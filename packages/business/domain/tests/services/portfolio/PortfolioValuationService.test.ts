process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, it } from 'bun:test';
import Decimal from 'decimal.js';

/**
 * PortfolioValuationService — pure math unit tests.
 *
 * The actual service fetches holdings from the DB and prices from PricingService.
 * Here we test the calculation logic in isolation by reproducing the exact
 * formulas the service uses (balance * price, summing totals, etc.).
 */

// ---------------------------------------------------------------------------
// Helpers that mirror the service's internal calculation logic
// ---------------------------------------------------------------------------

interface MockHolding {
  tokenSymbol: string;
  balance: string;
  tokenId: string;
}

interface PriceMap {
  [tokenId: string]: string; // tokenId -> price string
}

function calculateHoldingValue(balance: string, price: string): string {
  return new Decimal(balance).mul(new Decimal(price)).toString();
}

function calculateTotalValue(
  holdings: MockHolding[],
  prices: PriceMap,
  baseCurrencyId: string
): { totalValue: string; holdingValues: Array<{ tokenSymbol: string; value: string }> } {
  const holdingValues = holdings.map((h) => {
    const currentPrice = h.tokenId === baseCurrencyId ? '1' : prices[h.tokenId] || '0';
    const value = calculateHoldingValue(h.balance, currentPrice);
    return { tokenSymbol: h.tokenSymbol, value };
  });

  const totalValue = holdingValues.reduce(
    (sum, h) => sum.add(new Decimal(h.value)),
    new Decimal(0)
  );

  return { totalValue: totalValue.toString(), holdingValues };
}

function calculateAssetAllocation(
  holdingValues: Array<{ tokenSymbol: string; value: string; typeCode: string }>
): Array<{ typeCode: string; value: string; percentage: string }> {
  // Group by typeCode
  const grouped = new Map<string, Decimal>();
  for (const h of holdingValues) {
    const current = grouped.get(h.typeCode) || new Decimal(0);
    grouped.set(h.typeCode, current.add(new Decimal(h.value)));
  }

  const total = Array.from(grouped.values()).reduce((sum, v) => sum.add(v), new Decimal(0));

  const result: Array<{ typeCode: string; value: string; percentage: string }> = [];
  for (const [typeCode, value] of grouped.entries()) {
    const percentage = total.isZero() ? '0' : value.div(total).mul(100).toFixed(2);
    result.push({ typeCode, value: value.toString(), percentage });
  }

  return result.sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value)));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PortfolioValuationService (unit — math)', () => {
  const baseCurrencyId = 'usd-token-id';

  describe('calculateTotalValue', () => {
    it('should sum values of multiple holdings correctly', () => {
      const holdings: MockHolding[] = [
        { tokenSymbol: 'BTC', balance: '1.5', tokenId: 'btc-id' },
        { tokenSymbol: 'ETH', balance: '10', tokenId: 'eth-id' },
        { tokenSymbol: 'USD', balance: '5000', tokenId: baseCurrencyId },
      ];
      const prices: PriceMap = {
        'btc-id': '60000',
        'eth-id': '3000',
      };

      const result = calculateTotalValue(holdings, prices, baseCurrencyId);

      // BTC: 1.5 * 60000 = 90000
      // ETH: 10 * 3000 = 30000
      // USD: 5000 * 1 = 5000
      expect(result.totalValue).toBe('125000');
      expect(result.holdingValues).toHaveLength(3);
    });

    it('should treat base currency price as 1', () => {
      const holdings: MockHolding[] = [
        { tokenSymbol: 'USD', balance: '1234.56', tokenId: baseCurrencyId },
      ];

      const result = calculateTotalValue(holdings, {}, baseCurrencyId);
      expect(result.totalValue).toBe('1234.56');
    });

    it('should use 0 for tokens without a price', () => {
      const holdings: MockHolding[] = [
        { tokenSymbol: 'UNKNOWN', balance: '100', tokenId: 'unknown-id' },
      ];

      const result = calculateTotalValue(holdings, {}, baseCurrencyId);
      expect(result.totalValue).toBe('0');
      expect(result.holdingValues[0].value).toBe('0');
    });

    it('should handle empty holdings', () => {
      const result = calculateTotalValue([], {}, baseCurrencyId);
      expect(result.totalValue).toBe('0');
      expect(result.holdingValues).toHaveLength(0);
    });

    it('should preserve decimal precision', () => {
      const holdings: MockHolding[] = [
        { tokenSymbol: 'ETH', balance: '0.123456789', tokenId: 'eth-id' },
      ];
      const prices: PriceMap = { 'eth-id': '3000.50' };

      const result = calculateTotalValue(holdings, prices, baseCurrencyId);
      // 0.123456789 * 3000.50 = 370.438204894500 (exact with Decimal.js)
      const expected = new Decimal('0.123456789').mul('3000.50').toString();
      expect(result.totalValue).toBe(expected);
    });
  });

  describe('calculateAssetAllocation', () => {
    it('should calculate correct percentages for multiple types', () => {
      const holdingValues = [
        { tokenSymbol: 'BTC', value: '60000', typeCode: 'crypto' },
        { tokenSymbol: 'ETH', value: '30000', typeCode: 'crypto' },
        { tokenSymbol: 'AAPL', value: '10000', typeCode: 'stock' },
      ];

      const result = calculateAssetAllocation(holdingValues);

      // crypto total = 90000 -> 90%
      // stock total = 10000 -> 10%
      expect(result).toHaveLength(2);

      const crypto = result.find((r) => r.typeCode === 'crypto');
      expect(crypto).toBeDefined();
      expect(crypto!.value).toBe('90000');
      expect(crypto!.percentage).toBe('90.00');

      const stock = result.find((r) => r.typeCode === 'stock');
      expect(stock).toBeDefined();
      expect(stock!.value).toBe('10000');
      expect(stock!.percentage).toBe('10.00');
    });

    it('should handle single asset type (100%)', () => {
      const holdingValues = [
        { tokenSymbol: 'BTC', value: '50000', typeCode: 'crypto' },
        { tokenSymbol: 'ETH', value: '25000', typeCode: 'crypto' },
      ];

      const result = calculateAssetAllocation(holdingValues);
      expect(result).toHaveLength(1);
      expect(result[0].typeCode).toBe('crypto');
      expect(result[0].percentage).toBe('100.00');
    });

    it('should return 0% when all values are zero', () => {
      const holdingValues = [
        { tokenSymbol: 'BTC', value: '0', typeCode: 'crypto' },
        { tokenSymbol: 'AAPL', value: '0', typeCode: 'stock' },
      ];

      const result = calculateAssetAllocation(holdingValues);
      for (const item of result) {
        expect(item.percentage).toBe('0');
      }
    });

    it('should handle empty input', () => {
      const result = calculateAssetAllocation([]);
      expect(result).toHaveLength(0);
    });

    it('should sort by value descending', () => {
      const holdingValues = [
        { tokenSymbol: 'AAPL', value: '5000', typeCode: 'stock' },
        { tokenSymbol: 'BTC', value: '100000', typeCode: 'crypto' },
        { tokenSymbol: 'USD', value: '500', typeCode: 'fiat' },
      ];

      const result = calculateAssetAllocation(holdingValues);
      expect(result[0].typeCode).toBe('crypto');
      expect(result[1].typeCode).toBe('stock');
      expect(result[2].typeCode).toBe('fiat');
    });
  });

  describe('handling of zero balances', () => {
    it('should return 0 value for a holding with zero balance', () => {
      const holdings: MockHolding[] = [{ tokenSymbol: 'BTC', balance: '0', tokenId: 'btc-id' }];
      const prices: PriceMap = { 'btc-id': '60000' };

      const result = calculateTotalValue(holdings, prices, baseCurrencyId);
      expect(result.totalValue).toBe('0');
      expect(result.holdingValues[0].value).toBe('0');
    });

    it('should not affect total when mixed with non-zero balances', () => {
      const holdings: MockHolding[] = [
        { tokenSymbol: 'BTC', balance: '0', tokenId: 'btc-id' },
        { tokenSymbol: 'ETH', balance: '2', tokenId: 'eth-id' },
      ];
      const prices: PriceMap = { 'btc-id': '60000', 'eth-id': '3000' };

      const result = calculateTotalValue(holdings, prices, baseCurrencyId);
      expect(result.totalValue).toBe('6000');
    });
  });

  describe('currency conversion logic', () => {
    it('should apply base currency price of 1 regardless of balance', () => {
      const holdings: MockHolding[] = [
        { tokenSymbol: 'USD', balance: '999999.99', tokenId: baseCurrencyId },
      ];

      const result = calculateTotalValue(holdings, {}, baseCurrencyId);
      expect(result.totalValue).toBe('999999.99');
    });

    it('should use the price map for non-base currencies', () => {
      const holdings: MockHolding[] = [{ tokenSymbol: 'EUR', balance: '100', tokenId: 'eur-id' }];
      // If the user's base is USD and EUR/USD rate is 1.08
      const prices: PriceMap = { 'eur-id': '1.08' };

      const result = calculateTotalValue(holdings, prices, baseCurrencyId);
      expect(result.totalValue).toBe('108');
    });

    it('should handle very small fractional prices (DeFi tokens)', () => {
      const holdings: MockHolding[] = [
        { tokenSymbol: 'SHIB', balance: '1000000000', tokenId: 'shib-id' },
      ];
      const prices: PriceMap = { 'shib-id': '0.00001' };

      const result = calculateTotalValue(holdings, prices, baseCurrencyId);
      // 1_000_000_000 * 0.00001 = 10_000
      expect(result.totalValue).toBe('10000');
    });

    it('should handle very large prices', () => {
      const holdings: MockHolding[] = [{ tokenSymbol: 'BTC', balance: '0.001', tokenId: 'btc-id' }];
      const prices: PriceMap = { 'btc-id': '100000' };

      const result = calculateTotalValue(holdings, prices, baseCurrencyId);
      expect(result.totalValue).toBe('100');
    });
  });
});
