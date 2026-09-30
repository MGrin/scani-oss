import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import {
  columnChoices,
  columnFromOption,
  columnOption,
  NO_COLUMN,
} from '../../../src/v3/lib/csv-columns';

describe('CSV column options (SC-1397)', () => {
  const headers = ['Date', '__none__', '', 'Amount'];

  test('a header named like the "none" choice stays a real column', () => {
    const option = columnOption('__none__', headers);
    expect(option).not.toBe(NO_COLUMN);
    expect(columnFromOption(option, headers)).toBe('__none__');
  });

  test('an unmapped field round-trips as no column', () => {
    expect(columnOption('', headers)).toBe(NO_COLUMN);
    expect(columnFromOption(NO_COLUMN, headers)).toBe('');
  });

  test('a column with no name is not offered, since it cannot be mapped by name', () => {
    expect(columnChoices(headers).map((choice) => choice.label)).toEqual([
      'Date',
      '__none__',
      'Amount',
    ]);
  });

  test('every choice has its own value', () => {
    const values = columnChoices(['Amount', 'Amount']).map((choice) => choice.value);
    expect(new Set(values).size).toBe(2);
  });
});
