import { describe, expect, test } from 'bun:test';
import { compareValue } from '../../../src/services/foundation/value-comparison';

const AT = new Date('2026-10-07T00:00:00.000Z');
const READ = new Date('2026-10-06T23:00:00.000Z');
const live = (value: string | null, readingAt: Date | null = READ, isBase = false) => ({
  value,
  readingAt,
  price: value === null ? null : '10',
  balance: '2',
  isBase,
});

describe('compareValue (SC-1610)', () => {
  test('agrees exactly, however the decimal is written', () => {
    expect(compareValue({ value: '20', pricedAt: READ }, live('20.000'), AT)).toBeNull();
    expect(compareValue({ value: null, pricedAt: null }, live(null, null), AT)).toBeNull();
  });

  test('a difference past the last digit is still a difference', () => {
    const d = compareValue({ value: '20.0000000000000000001', pricedAt: READ }, live('20'), AT);
    expect(d?.category).toBe('same-reading-value-differs');
  });

  test('names each cause', () => {
    expect(compareValue({ value: null, pricedAt: null }, live('20'), AT)?.category).toBe(
      'not-valued'
    );
    expect(compareValue({ value: '20', pricedAt: READ }, live(null, null), AT)?.category).toBe(
      'no-longer-priced'
    );
    const later = new Date(READ.getTime() + 60_000);
    expect(compareValue({ value: '20', pricedAt: READ }, live('22', later), AT)).toMatchObject({
      comparator: 'cache-vs-live',
      category: 'price-moved-since',
      engineValue: '20',
      legacyValue: '22',
      detail: { cachedPricedAt: READ.toISOString(), liveReadingAt: later.toISOString() },
    });
  });

  test('the base currency is judged on its value alone: its identity price has no reading', () => {
    expect(compareValue({ value: '2', pricedAt: READ }, live('2', AT, true), AT)).toBeNull();
    expect(compareValue({ value: '2', pricedAt: READ }, live('3', AT, true), AT)?.category).toBe(
      'same-reading-value-differs'
    );
  });
});
