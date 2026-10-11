import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { orderWrappers, regionOfCurrency } from '../../../src/v3/lib/wrappers';

// SC-1645: the picker lists the base currency's region first, as Sure does.

const rows = [
  { code: 'brokerage', region: 'us', treatment: 'general', displayOrder: 1 },
  { code: 'roth_ira', region: 'us', treatment: 'exempt', displayOrder: 9 },
  { code: 'isa', region: 'uk', treatment: 'exempt', displayOrder: 16 },
  { code: 'sipp', region: 'uk', treatment: 'deferred', displayOrder: 18 },
  { code: 'tfsa', region: 'ca', treatment: 'exempt', displayOrder: 20 },
  { code: 'super', region: 'au', treatment: 'deferred', displayOrder: 34 },
  { code: 'pea', region: 'eu', treatment: 'advantaged', displayOrder: 37 },
  { code: 'pension', region: null, treatment: 'deferred', displayOrder: 40 },
] as const;

describe('regionOfCurrency', () => {
  test('maps the five currencies with a region, and nothing else', () => {
    expect(regionOfCurrency('GBP')).toBe('uk');
    expect(regionOfCurrency('USD')).toBe('us');
    expect(regionOfCurrency('CHF')).toBe('eu');
    expect(regionOfCurrency('JPY')).toBeNull();
  });
});

describe('orderWrappers', () => {
  test("the user's region first, then generic, then the rest in a fixed order", () => {
    const groups = orderWrappers(rows, 'uk');
    expect(groups.map((g) => g.region)).toEqual(['uk', null, 'us', 'ca', 'au', 'eu']);
    expect(groups[0]?.codes).toEqual(['isa', 'sipp']);
  });

  test('a currency with no region starts with generic, then us', () => {
    expect(orderWrappers(rows, null).map((g) => g.region)).toEqual([
      null,
      'us',
      'uk',
      'ca',
      'au',
      'eu',
    ]);
  });
});
