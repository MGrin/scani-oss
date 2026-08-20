import { describe, expect, test } from 'bun:test';
import { type Cashflow, xirr } from '../../../src/lib/returns/xirr';

const DAY_MS = 24 * 60 * 60 * 1000;

function flow(date: string, amount: number): Cashflow {
  return { at: new Date(`${date}T00:00:00.000Z`), amount };
}

/** The definition itself, re-implemented in the test so the assertions do not
 * rest on the same arithmetic the solver uses to find the root. */
function npv(flows: readonly Cashflow[], rate: number): number {
  const origin = Math.min(...flows.map((f) => f.at.getTime()));
  return flows.reduce(
    (sum, f) => sum + f.amount / (1 + rate) ** ((f.at.getTime() - origin) / (DAY_MS * 365)),
    0
  );
}

function rateOf(result: ReturnType<typeof xirr>): number {
  if (result.status !== 'ok') throw new Error(`expected a rate, got ${result.status}`);
  return result.rate;
}

describe('xirr — worked examples a spreadsheet agrees with', () => {
  test('scenario: 1000 in, 1100 out exactly one year later is 10.00%', () => {
    const result = xirr([flow('2025-01-01', -1000), flow('2026-01-01', 1100)]);
    expect(rateOf(result)).toBeCloseTo(0.1, 10);
    expect(result.status === 'ok' && result.uniqueRoot).toBe(true);
  });

  test("scenario: Microsoft's own XIRR documentation example is 37.34%", () => {
    // The five cashflows from the Excel XIRR help page. Its stated answer is
    // 0.373362535. Any drift from that figure is this solver disagreeing with
    // the spreadsheet a user would check us against.
    const flows = [
      flow('2008-01-01', -10000),
      flow('2008-03-01', 2750),
      flow('2008-10-30', 4250),
      flow('2009-02-15', 3250),
      flow('2009-04-01', 2750),
    ];
    const result = xirr(flows);
    expect(rateOf(result)).toBeCloseTo(0.373362535, 7);
    expect(Math.abs(npv(flows, rateOf(result)))).toBeLessThan(1e-6);
  });

  test('scenario: staggered contributions — the root really zeroes the NPV', () => {
    const flows = [flow('2025-01-01', -1000), flow('2025-07-01', -1000), flow('2026-01-01', 2100)];
    const result = xirr(flows);
    expect(result.status).toBe('ok');
    expect(Math.abs(npv(flows, rateOf(result)))).toBeLessThan(1e-7);
    // Buying more before a gain drags the money-weighted rate below the
    // simple 5% the totals suggest, because half the money was in for
    // half the time.
    expect(rateOf(result)).toBeGreaterThan(0.05);
  });

  test('scenario: a loss — 1000 in, 800 out after a year is -20%', () => {
    expect(rateOf(xirr([flow('2025-01-01', -1000), flow('2026-01-01', 800)]))).toBeCloseTo(
      -0.2,
      10
    );
  });

  test('scenario: near-total loss stays inside the domain, above -100%', () => {
    const result = xirr([flow('2025-01-01', -1000), flow('2026-01-01', 1)]);
    expect(rateOf(result)).toBeCloseTo(-0.999, 6);
    expect(rateOf(result)).toBeGreaterThan(-1);
  });

  test('scenario: a sub-year window still reports an ANNUAL rate', () => {
    // Doubling in 182 days is 2^(365/182) - 1 = +301.5%/yr, not +100%.
    const result = xirr([flow('2025-01-01', -100), flow('2025-07-02', 200)]);
    expect(rateOf(result)).toBeCloseTo(2 ** (365 / 182) - 1, 8);
    expect(rateOf(result)).toBeGreaterThan(3);
  });

  test('order of the input does not change the answer', () => {
    const ordered = xirr([flow('2025-01-01', -1000), flow('2026-01-01', 1100)]);
    const shuffled = xirr([flow('2026-01-01', 1100), flow('2025-01-01', -1000)]);
    expect(rateOf(shuffled)).toBeCloseTo(rateOf(ordered), 12);
  });
});

describe('xirr — questions with no answer return no number at all', () => {
  test('money that only ever went in has no rate of return', () => {
    const result = xirr([flow('2025-01-01', -1000), flow('2026-01-01', -500)]);
    expect(result).toEqual({ status: 'undefined', reason: 'no-sign-change' });
    expect('rate' in result).toBe(false);
  });

  test('money that only ever came out has none either', () => {
    expect(xirr([flow('2025-01-01', 1000), flow('2026-01-01', 500)])).toEqual({
      status: 'undefined',
      reason: 'no-sign-change',
    });
  });

  test('a single cashflow is too few', () => {
    expect(xirr([flow('2025-01-01', -1000)])).toEqual({
      status: 'undefined',
      reason: 'too-few-flows',
    });
    expect(xirr([])).toEqual({ status: 'undefined', reason: 'too-few-flows' });
  });

  test('a rate below what a float64 can hold is refused, not rounded to the nearest one', () => {
    // A 14% loss compounded 365 times: the root is at 1 + r ~ 1e-35, which
    // `-1 + 1e-35` cannot represent. Reporting -99.999999% instead would be a
    // number nobody could tell from a real one.
    const result = xirr([flow('2026-03-01', -1400), flow('2026-03-02', 1200)]);
    expect(result).toEqual({ status: 'not-converged', reason: 'no-root-in-domain' });
    expect('rate' in result).toBe(false);
  });

  test('everything on one instant spans no time, so no annual rate exists', () => {
    expect(xirr([flow('2025-01-01', -1000), flow('2025-01-01', 1100)])).toEqual({
      status: 'undefined',
      reason: 'zero-span',
    });
  });
});

describe('xirr — honesty about the root it found', () => {
  test('more than one sign change is reported, not hidden', () => {
    const flows = [
      flow('2025-01-01', -1000),
      flow('2025-04-01', 3000),
      flow('2025-08-01', -2500),
      flow('2026-01-01', 600),
    ];
    const result = xirr(flows);
    if (result.status !== 'ok') throw new Error('expected a root');
    expect(result.uniqueRoot).toBe(false);
    // Still a genuine root of the NPV, just not provably the only one.
    expect(Math.abs(npv(flows, result.rate))).toBeLessThan(1e-6);
  });

  test('a single sign change is certified unique', () => {
    const result = xirr([
      flow('2025-01-01', -1000),
      flow('2025-06-01', -500),
      flow('2026-01-01', 1800),
    ]);
    expect(result.status === 'ok' && result.uniqueRoot).toBe(true);
  });

  test('the solver names its method and its iteration count', () => {
    const result = xirr([flow('2025-01-01', -1000), flow('2026-01-01', 1100)]);
    if (result.status !== 'ok') throw new Error('expected a root');
    expect(['bisection', 'bisection+newton']).toContain(result.method);
    expect(result.iterations).toBeGreaterThanOrEqual(0);
  });

  test('a portfolio of pennies converges as tightly as one of millions', () => {
    const small = xirr([flow('2025-01-01', -0.01), flow('2026-01-01', 0.011)]);
    const large = xirr([flow('2025-01-01', -10_000_000), flow('2026-01-01', 11_000_000)]);
    expect(rateOf(small)).toBeCloseTo(0.1, 8);
    expect(rateOf(large)).toBeCloseTo(0.1, 8);
  });
});
