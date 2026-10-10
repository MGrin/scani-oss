import { describe, expect, test } from 'bun:test';
import { extractPriceMap } from '../../src/lib/price-map';

describe('extractPriceMap', () => {
  test('a token held only at a negative balance is priced', () => {
    const map = extractPriceMap({ holdings: [{ tokenId: 'usd', currentPrice: '0.8' }] });
    expect(map.get('usd')).toBe('0.8');
  });

  test('the price is the valuation’s, whatever the balance', () => {
    const map = extractPriceMap({ holdings: [{ tokenId: 'btc', currentPrice: '42' }] });
    expect(map.get('btc')).toBe('42');
  });

  test('an unpriced holding gives no price', () => {
    const map = extractPriceMap({ holdings: [{ tokenId: 'usd', currentPrice: null }] });
    expect(map.has('usd')).toBe(false);
  });
});
