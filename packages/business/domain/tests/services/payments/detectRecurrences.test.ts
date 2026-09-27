import { describe, expect, test } from 'bun:test';
import {
  currencyClasses,
  detectMonthlyRecurrences,
  type ObservedOutflow,
} from '../../../src/services/payments/detectRecurrences';

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);
let n = 0;
const out = (
  iso: string,
  amount: string,
  counterparty: string | null = 'landlord',
  currency = 'GBP'
): ObservedOutflow => ({ id: `tx-${++n}`, occurredAt: day(iso), amount, currency, counterparty });

describe('detectMonthlyRecurrences', () => {
  test("SC-674's series: six monthly payments, then a settling lump, reads as ENDED", () => {
    const rows = [
      out('2026-01-09', '120'),
      out('2026-02-10', '120'),
      out('2026-03-02', '120'),
      out('2026-04-10', '120'),
      out('2026-05-08', '120'),
      out('2026-06-04', '120'),
      out('2026-06-09', '16236'),
    ];
    const [found, ...rest] = detectMonthlyRecurrences(rows, day('2026-08-26'));
    expect(rest).toEqual([]);
    expect(found).toMatchObject({
      counterparty: 'landlord',
      currency: 'GBP',
      amount: '120',
      occurrences: 6,
      status: 'ended',
    });
    expect(found?.lastAt).toEqual(day('2026-06-04'));
    expect(found?.transactionIds).toHaveLength(6);
  });

  test('the same series with a recent payment reads as ACTIVE', () => {
    const rows = ['2026-05-03', '2026-06-02', '2026-07-03', '2026-08-01'].map((d) =>
      out(d, '49.99', 'gym')
    );
    const [found] = detectMonthlyRecurrences(rows, day('2026-08-26'));
    expect(found).toMatchObject({ counterparty: 'gym', occurrences: 4, status: 'active' });
  });

  test('amounts within 2% still match; the reported amount is the median', () => {
    const rows = [
      out('2026-05-01', '100.00', 'power'),
      out('2026-06-01', '101.50', 'power'),
      out('2026-07-01', '99.20', 'power'),
    ];
    expect(detectMonthlyRecurrences(rows, day('2026-07-20'))[0]?.amount).toBe('100');
  });

  test('two payments are not a pattern', () => {
    const rows = [out('2026-06-01', '20', 'x'), out('2026-07-01', '20', 'x')];
    expect(detectMonthlyRecurrences(rows, day('2026-07-10'))).toEqual([]);
  });

  test('weekly or irregular gaps are not monthly', () => {
    const weekly = ['2026-07-01', '2026-07-08', '2026-07-15', '2026-07-22'].map((d) =>
      out(d, '10', 'cafe')
    );
    const irregular = ['2026-01-01', '2026-02-01', '2026-04-15', '2026-05-15'].map((d) =>
      out(d, '10', 'club')
    );
    expect(detectMonthlyRecurrences([...weekly, ...irregular], day('2026-05-20'))).toEqual([]);
  });

  test('a different payee, currency or amount does not join a series', () => {
    const rows = [
      out('2026-05-01', '30', 'a'),
      out('2026-06-01', '30', 'b'),
      out('2026-07-01', '30', 'a', 'EUR'),
      out('2026-08-01', '45', 'a'),
    ];
    expect(detectMonthlyRecurrences(rows, day('2026-08-10'))).toEqual([]);
  });

  test('an outflow with no counterparty is never grouped', () => {
    const rows = ['2026-05-01', '2026-06-01', '2026-07-01'].map((d) => out(d, '12', null));
    expect(detectMonthlyRecurrences(rows, day('2026-07-10'))).toEqual([]);
  });

  test('input order does not matter', () => {
    const rows = ['2026-07-01', '2026-05-01', '2026-06-01'].map((d) => out(d, '8', 'svc'));
    expect(detectMonthlyRecurrences(rows, day('2026-07-10'))).toHaveLength(1);
  });
});

describe('currencyClasses', () => {
  test('coins priced within 2% of each other share one key; a coin at twice the price does not', () => {
    const classes = currencyClasses(
      ['usdc', 'usdt', 'usd', 'eth'],
      new Map([
        ['usdt', '0.995'],
        ['usdc', '1.005'],
        ['usd', '1'],
        ['eth', '2'],
      ])
    );
    expect(new Set([classes.get('usdt'), classes.get('usdc'), classes.get('usd')]).size).toBe(1);
    expect(classes.get('eth')).toBe('eth');
  });

  test('a token with no usable price is its own currency', () => {
    const classes = currencyClasses(
      ['a', 'b', 'c'],
      new Map([
        ['a', '1'],
        ['c', '0'],
      ])
    );
    expect(classes).toEqual(
      new Map([
        ['a', 'a'],
        ['b', 'b'],
        ['c', 'c'],
      ])
    );
  });
});
