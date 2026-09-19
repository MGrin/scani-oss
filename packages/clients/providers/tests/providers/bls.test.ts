import { describe, expect, test } from 'bun:test';
import { parseBlsMonthly } from '../../src/providers/bls';

describe('parseBlsMonthly (SC-1255)', () => {
  test('monthly points, oldest first, as the first of each month', () => {
    const points = parseBlsMonthly({
      status: 'REQUEST_SUCCEEDED',
      Results: {
        series: [
          {
            data: [
              { year: '2026', period: 'M08', value: '335.0' },
              { year: '2026', period: 'M07', value: '334.0' },
            ],
          },
        ],
      },
    });
    expect(points).toEqual([
      { month: '2026-07-01', value: '334.0' },
      { month: '2026-08-01', value: '335.0' },
    ]);
  });

  test('an annual average (M13) and a missing value are not months', () => {
    const points = parseBlsMonthly({
      Results: {
        series: [
          {
            data: [
              { year: '2025', period: 'M13', value: '320.0' },
              { year: '2025', period: 'M12', value: '-' },
              { year: '2025', period: 'M11', value: '321.0' },
            ],
          },
        ],
      },
    });
    expect(points).toEqual([{ month: '2025-11-01', value: '321.0' }]);
  });

  test('no series is no points', () => {
    expect(parseBlsMonthly({ status: 'REQUEST_NOT_PROCESSED' })).toEqual([]);
  });
});
