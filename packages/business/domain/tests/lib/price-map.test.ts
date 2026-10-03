import { describe, expect, test } from 'bun:test';
import { extractPriceMap } from '../../src/lib/price-map';

describe('extractPriceMap', () => {
  test('a token held only at a negative balance is priced', () => {
    const map = extractPriceMap({
      holdings: [{ tokenId: 'usd', balance: '-1200', value: '-960' }],
    });
    expect(map.get('usd')).toBe('0.8');
  });

  test('a zero balance gives no price', () => {
    const map = extractPriceMap({
      holdings: [{ tokenId: 'usd', balance: '0', value: '0' }],
    });
    expect(map.has('usd')).toBe(false);
  });

  test('an unpriced holding gives no price', () => {
    const map = extractPriceMap({
      holdings: [{ tokenId: 'usd', balance: '-1200', value: null }],
    });
    expect(map.has('usd')).toBe(false);
  });
});
