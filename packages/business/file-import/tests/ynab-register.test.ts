import { describe, expect, it } from 'bun:test';
import { parseYnabRegister } from '../src/ynab-register';

const WEB_HEADER =
  '﻿"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"';

function parsed(text: string, order?: 'day-first' | 'month-first') {
  const result = parseYnabRegister(text, order);
  if (result.kind !== 'parsed') throw new Error(`expected parsed, got ${result.kind}`);
  return result;
}

describe('parseYnabRegister', () => {
  it('reads a web register: accounts, signed amounts, categories and both sides of a transfer', () => {
    const file = [
      WEB_HEADER,
      '"Checking","","08/14/2026","Grocer","Everyday: Food","Everyday","Food","weekly","$84.23","$0.00","Cleared"',
      '"Checking","Red","08/15/2026","Employer","Inflow: Ready to Assign","Inflow","Ready to Assign","","$0.00","$2,500.00","Reconciled"',
      '"Checking","","08/16/2026","Transfer : Savings","","","","","$300.00","$0.00","Uncleared"',
      '"Savings","","08/16/2026","Transfer : Checking","","","","","$0.00","$300.00","Uncleared"',
    ].join('\n');

    const result = parsed(file);

    expect(result.currencySymbol).toBe('$');
    expect(result.accounts.map((a) => [a.name, a.rows.length])).toEqual([
      ['Checking', 3],
      ['Savings', 1],
    ]);
    const [grocer, salary, out] = result.accounts[0]!.rows;
    expect(grocer).toMatchObject({
      amount: '-84.23',
      payee: 'Grocer',
      memo: 'weekly',
      category: 'Everyday: Food',
      cleared: 'Cleared',
      flag: null,
      transferAccount: null,
      line: 2,
    });
    expect(grocer!.date.toISOString()).toBe('2026-08-14T00:00:00.000Z');
    expect(salary).toMatchObject({ amount: '2500', flag: 'Red', cleared: 'Reconciled' });
    expect(out).toMatchObject({ amount: '-300', transferAccount: 'Savings', category: null });
    expect(result.accounts[1]!.rows[0]).toMatchObject({
      amount: '300',
      transferAccount: 'Checking',
    });
    expect(result.skipped).toEqual([]);
  });

  it('reads a decimal-comma TSV with dotted day-first dates and trailing symbols', () => {
    const file = [
      'Account\tFlag\tDate\tPayee\tCategory Group/Category\tCategory Group\tCategory\tMemo\tOutflow\tInflow\tCleared',
      'Girokonto\t\t25.08.2026\tBäcker\tAlltag: Essen\tAlltag\tEssen\t\t84,23€\t0,00€\tCleared',
      'Girokonto\t\t01.09.2026\tArbeit\t\t\t\t\t0,00€\t1.234,56€\tCleared',
    ].join('\n');

    const result = parsed(file);

    expect(result.currencySymbol).toBe('€');
    const [bread, pay] = result.accounts[0]!.rows;
    expect(bread!.amount).toBe('-84.23');
    expect(bread!.date.toISOString()).toBe('2026-08-25T00:00:00.000Z');
    expect(pay!.amount).toBe('1234.56');
    expect(pay!.date.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('stops on dates that fit either order, and reads them once the order is given', () => {
    const file = [
      WEB_HEADER,
      '"Checking","","03/04/2026","A","","","","","$1.00","$0.00","Cleared"',
      '"Checking","","05/06/2026","B","","","","","$2.00","$0.00","Cleared"',
    ].join('\n');

    const stopped = parseYnabRegister(file);
    expect(stopped.kind).toBe('ambiguous-dates');
    if (stopped.kind === 'ambiguous-dates') expect(stopped.dates.rowCount).toBe(2);

    const dayFirst = parsed(file, 'day-first');
    expect(dayFirst.accounts[0]!.rows[0]!.date.toISOString()).toBe('2026-04-03T00:00:00.000Z');
  });

  it('reads a YNAB4 register: master and sub category, no currency symbol', () => {
    const file = [
      '"Account","Flag","Check Number","Date","Payee","Category","Master Category","Sub Category","Memo","Outflow","Inflow","Cleared","Running Balance"',
      '"Cash","","","2015/03/14","Cafe","Food: Dining","Food","Dining","","4.50","0.00","C","95.50"',
    ].join('\n');

    const result = parsed(file);

    expect(result.currencySymbol).toBeNull();
    expect(result.accounts[0]!.rows[0]).toMatchObject({
      amount: '-4.5',
      category: 'Food: Dining',
      cleared: 'C',
    });
  });

  it('reads a zero-decimal currency, where every separator groups thousands', () => {
    const file = [
      WEB_HEADER,
      '"財布","","08/14/2026","Shop","","","","","¥1,234","¥0","Cleared"',
      '"財布","","08/15/2026","Shop","","","","","¥80","¥0","Cleared"',
    ].join('\n');

    const result = parsed(file);

    expect(result.currencySymbol).toBe('¥');
    expect(result.accounts[0]!.rows.map((r) => r.amount)).toEqual(['-1234', '-80']);
  });

  it('names every row it skips, by line and reason, and keeps the rest', () => {
    const file = [
      WEB_HEADER,
      '"Checking","","08/14/2026","Starting Balance","","","","","$0.00","$0.00","Cleared"',
      '"Checking","","not a date","A","","","","","$1.00","$0.00","Cleared"',
      '"","","08/14/2026","B","","","","","$1.00","$0.00","Cleared"',
      '"Checking","","08/14/2026","C","","","","","lots","$0.00","Cleared"',
      '"Checking","","08/14/2026","D","","","","","$5.00","$0.00","Cleared"',
      '"Checking","","","","",,"",,,,""',
    ].join('\n');

    const result = parsed(file);

    expect(result.skipped).toEqual([
      { line: 2, reason: 'zero-amount' },
      { line: 3, reason: 'unreadable-date' },
      { line: 4, reason: 'no-account' },
      { line: 5, reason: 'unreadable-amount' },
      { line: 7, reason: 'empty-row' },
    ]);
    expect(result.accounts[0]!.rows.map((r) => r.payee)).toEqual(['D']);
  });

  it('refuses a file that is not a register, naming the columns it lacks', () => {
    const plan =
      '"Month","Category Group/Category","Category Group","Category","Budgeted","Activity","Available"';
    const result = parseYnabRegister(plan);
    expect(result).toEqual({
      kind: 'not-a-register',
      missing: ['Account', 'Date', 'Payee', 'Memo', 'Outflow', 'Inflow'],
    });
  });

  it('refuses amounts that use both separators as the decimal point', () => {
    const file = [
      WEB_HEADER,
      '"Checking","","08/14/2026","A","","","","","$1.50","$0.00","Cleared"',
      '"Checking","","08/14/2026","B","","","","","$2,75","$0.00","Cleared"',
    ].join('\n');
    expect(parseYnabRegister(file).kind).toBe('mixed-decimal-separators');
  });
});
