import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import {
  cardUtilization,
  type LoanTerms,
  levelPayment,
  projectPayoff,
  schedule,
} from '../../../src/lib/liabilities/amortization';

const d = (v: Decimal.Value) => new Decimal(v);

// Sure's published example (docs.sure.am, debt accounts): 500,000 at 3.5% over 360 months.
const mortgage: LoanTerms = {
  principal: d(500000),
  annualRatePct: d('3.5'),
  termMonths: 360,
  startDate: '2026-01-15',
};

describe('levelPayment', () => {
  test("matches Sure's published mortgage example", () => {
    expect(levelPayment(d(500000), d('3.5'), 360, 2).toFixed(2)).toBe('2245.22');
  });

  test('a zero rate divides the principal evenly', () => {
    expect(levelPayment(d(12000), d(0), 12, 2).toFixed(2)).toBe('1000.00');
  });
});

describe('schedule', () => {
  test('has one row per month and ends at exactly zero', () => {
    const rows = schedule(mortgage, 2);
    expect(rows).toHaveLength(360);
    expect(rows[0]?.interest.toFixed(2)).toBe('1458.33');
    expect(rows[0]?.payment.toFixed(2)).toBe('2245.22');
    expect(rows.at(-1)?.remaining.isZero()).toBe(true);
  });

  test('payment dates step by calendar month from the start and clamp month-ends', () => {
    const rows = schedule({ ...mortgage, startDate: '2026-01-31' }, 2);
    expect(rows.slice(0, 3).map((r) => r.date)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });
});

describe('projectPayoff', () => {
  const asOf = '2027-01-20'; // after the 12th payment (2027-01-15)
  const scheduledOwed = () => schedule(mortgage, 2)[11]?.remaining ?? d(0);

  test('nothing owed reads paid off', () => {
    const p = projectPayoff(mortgage, d(0), asOf, 2);
    expect(p.status).toBe('paid_off');
    expect(p.payoffDate).toBeNull();
    expect(p.remainingInterest.isZero()).toBe(true);
  });

  test('owing exactly what the schedule says is on track', () => {
    const p = projectPayoff(mortgage, scheduledOwed(), asOf, 2);
    expect(p.status).toBe('on_track');
    expect(p.monthsVsSchedule).toBe(0);
    expect(p.payoffDate).toBe('2056-01-15');
    expect(p.converged).toBe(true);
  });

  test('owing 10% less than the schedule is ahead', () => {
    const p = projectPayoff(mortgage, scheduledOwed().times('0.9'), asOf, 2);
    expect(p.status).toBe('ahead');
    expect(p.monthsVsSchedule).toBeLessThan(0);
  });

  test('owing 10% more than the schedule is behind and runs past maturity', () => {
    const p = projectPayoff(mortgage, scheduledOwed().times('1.1'), asOf, 2);
    expect(p.status).toBe('behind');
    expect(p.monthsVsSchedule).toBeGreaterThan(0);
    expect(p.converged).toBe(true);
  });

  test('a payment that never covers the interest does not converge, and returns', () => {
    const p = projectPayoff({ ...mortgage, payment: d(1000) }, scheduledOwed(), asOf, 2);
    expect(p.converged).toBe(false);
    expect(p.payoffDate).toBeNull();
    expect(p.status).toBe('behind');
  });
});

describe('projectPayoff review fixes', () => {
  test('the walk stops at 1200 periods instead of running for ever (review I1)', () => {
    const tiny = {
      principal: d(100000),
      annualRatePct: d(0),
      termMonths: 360,
      startDate: '2026-01-15',
      payment: d(10),
    };
    const started = Date.now();
    // Owing ten times the principal: past maturity at 10 a month it needs ~99,000 more periods.
    const p = projectPayoff(tiny, d(1000000), '2026-01-20', 2);
    expect(Date.now() - started).toBeLessThan(500);
    expect(p.converged).toBe(false);
    expect(p.payoffDate).toBeNull();
  });

  test('a rounded contracted payment that is on schedule reads on track (review I2)', () => {
    const rounded = { ...mortgage, payment: d(2245) };
    const owed = schedule(rounded, 2)[11]?.remaining ?? d(0);
    const p = projectPayoff(rounded, owed, '2027-01-20', 2);
    expect(p.status).toBe('on_track');
    expect(p.payoffDate).toBe('2056-01-15');
  });
});

describe('cardUtilization', () => {
  test('owed over limit, and the credit left', () => {
    const u = cardUtilization(d(1500), d(5000));
    expect(u.utilization?.toString()).toBe('0.3');
    expect(u.available?.toString()).toBe('3500');
  });

  test('no limit means no utilization rather than a division by zero', () => {
    expect(cardUtilization(d(1500), null)).toEqual({ utilization: null, available: null });
  });
});
