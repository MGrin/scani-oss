import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { materialStartIndex } from '../../../src/lib/returns/material-start';
import { computeTimeWeightedReturn, type ValuationPoint } from '../../../src/lib/returns/twr';

const series = (values: Array<[number, number?]>): ValuationPoint[] =>
  values.map(([value, flow = 0], i) => ({
    date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
    value: new Decimal(value),
    netExternalFlow: new Decimal(flow),
  }));

const start = (points: ValuationPoint[]) => {
  const twr = computeTimeWeightedReturn(points);
  if (!twr) throw new Error('no twr');
  return materialStartIndex(points, twr.periods);
};

describe('materialStartIndex (SC-1439)', () => {
  test('a tiny volatile start before a large deposit is not material', () => {
    // £100 swings -40% and +30%, then £10,000 arrives and holds steady.
    const points = series([[100], [60], [78], [10078, 10000], [10100], [10090]]);
    expect(start(points)).toBe(3);
  });

  test('a material day followed by a withdrawal to a tiny base is not the start', () => {
    // £3,000 is material on day one, then £2,900 leaves and £100 swings for
    // days before £9,900 arrives: the start is the deposit, not day one.
    const points = series([[3000], [100, -2900], [110], [99], [10000, 9900], [10050]]);
    expect(start(points)).toBe(4);
  });

  test('CONTROL: capital present from day one is material from day one', () => {
    const points = series([[10000], [9000], [11000], [10500]]);
    expect(start(points)).toBe(0);
  });

  test('pure growth is never trimmed, however large', () => {
    // £1,000 grows twentyfold with no money added: all of today's value is
    // that first day's capital.
    const points = series([[1000], [5000], [12000], [20000]]);
    expect(start(points)).toBe(0);
  });

  test('a crash is never trimmed', () => {
    const points = series([[10000], [3000], [1500], [1000]]);
    expect(start(points)).toBe(0);
  });

  test('a scope that ends at zero is left alone', () => {
    const points = series([[100], [50, 0], [0, -50]]);
    expect(start(points)).toBe(0);
  });
  test('a scope funded from zero keeps its funding day', () => {
    // The zero day measures nothing, so it decided nothing.
    const points = series([[0], [1000, 1000], [1100]]);
    expect(start(points)).toBe(0);
  });
});
