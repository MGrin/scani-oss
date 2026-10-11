import { describe, expect, it } from 'bun:test';
import { parseActualRegister } from '../src/actual-register';

// The account menu's Export in Actual Budget (`exportQueryToCSV`).
const HEADER = 'Account,Date,Payee,Notes,Category_Group,Category,Amount,Split_Amount,Cleared';

function parsed(text: string) {
  const result = parseActualRegister(text);
  if (result.kind !== 'parsed') throw new Error(`expected parsed, got ${result.kind}`);
  return result;
}

describe('parseActualRegister', () => {
  it('reads accounts, signed amounts, categories and both sides of a transfer', () => {
    const file = [
      HEADER,
      'Checking,2026-08-14,Grocer,weekly,Everyday,Food,-84.23,0,Cleared',
      'Checking,2026-08-15,Employer,,Income,Salary,2500,0,Reconciled',
      'Checking,2026-08-16,Savings,,,,-300,0,Not cleared',
      'Savings,2026-08-16,Checking,,,,300,0,Not cleared',
    ].join('\n');

    const result = parsed(file);

    expect(result.currencySymbol).toBeNull();
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
    expect(salary).toMatchObject({ amount: '2500', cleared: 'Reconciled' });
    expect(out).toMatchObject({ amount: '-300', transferAccount: 'Savings', category: null });
    expect(result.accounts[1]!.rows[0]).toMatchObject({
      amount: '300',
      transferAccount: 'Checking',
    });
  });

  it('a payee named like no account in the file is an ordinary payee, not a transfer', () => {
    const file = [HEADER, 'Checking,2026-08-16,Savings,,,,-300,0,Cleared'].join('\n');

    expect(parsed(file).accounts[0]!.rows[0]).toMatchObject({
      payee: 'Savings',
      transferAccount: null,
    });
  });

  it('lands a split as its parts, skipping the parent that carries only the total', () => {
    const file = [
      HEADER,
      'Checking,2026-08-20,Market,(SPLIT INTO 2) shop,,,0,-50,Cleared',
      'Checking,2026-08-20,Market,(SPLIT 1 OF 2) food,Everyday,Food,-30,0,Cleared',
      'Checking,2026-08-20,Market,(SPLIT 2 OF 2) ,Home,Supplies,-20,0,Cleared',
    ].join('\n');

    const result = parsed(file);

    expect(result.skipped).toEqual([{ line: 2, reason: 'split-parent' }]);
    expect(result.accounts[0]!.rows.map((r) => [r.amount, r.memo, r.category])).toEqual([
      ['-30', 'food', 'Everyday: Food'],
      ['-20', null, 'Home: Supplies'],
    ]);
  });

  it('removes the apostrophe Actual adds before a cell that starts like a formula', () => {
    const file = [HEADER, "Checking,2026-08-21,'-Refund desk,'=total,,,12.5,0,Cleared"].join('\n');

    expect(parsed(file).accounts[0]!.rows[0]).toMatchObject({
      payee: '-Refund desk',
      memo: '=total',
      amount: '12.5',
    });
  });

  it("reads the older export, whose category is already 'Group: Name' and whose cleared state is two flags", () => {
    const file = [
      'Account,Date,Payee,Notes,Category,Amount,Cleared,Reconciled',
      'Checking,2026-08-14,Grocer,,Everyday: Food,-84.23,true,false',
      'Checking,2026-08-15,Employer,,,2500,true,true',
      'Checking,2026-08-16,Shop,,,-5,false,false',
    ].join('\n');

    expect(parsed(file).accounts[0]!.rows.map((r) => [r.category, r.cleared])).toEqual([
      ['Everyday: Food', 'Cleared'],
      [null, 'Reconciled'],
      [null, 'Not cleared'],
    ]);
  });

  it('skips and counts what it cannot read', () => {
    const file = [
      HEADER,
      'Checking,08/14/2026,Grocer,,,,-1,0,Cleared',
      'Checking,2026-08-14,Grocer,,,,abc,0,Cleared',
      'Checking,2026-08-14,Grocer,,,,0,0,Cleared',
      ',2026-08-14,Grocer,,,,-1,0,Cleared',
      ',,,,,,,,',
      'Checking,2026-08-14,Grocer,,,,-1,0,Cleared',
    ].join('\n');

    const result = parsed(file);

    expect(result.skipped).toEqual([
      { line: 2, reason: 'unreadable-date' },
      { line: 3, reason: 'unreadable-amount' },
      { line: 4, reason: 'zero-amount' },
      { line: 5, reason: 'no-account' },
      { line: 6, reason: 'empty-row' },
    ]);
    expect(result.accounts[0]!.rows).toHaveLength(1);
  });

  it('refuses a file that is not an Actual export, naming the columns it lacks', () => {
    const ynab = '"Account","Flag","Date","Payee","Memo","Outflow","Inflow","Cleared"';

    expect(parseActualRegister(ynab)).toEqual({
      kind: 'not-a-register',
      missing: ['Notes', 'Amount'],
    });
  });

  it('reads a file saved with a byte-order mark', () => {
    const file = [`﻿${HEADER}`, 'Checking,2026-08-14,Grocer,,,,-1,0,Cleared'].join('\n');

    expect(parsed(file).accounts[0]!.rows).toHaveLength(1);
  });
});
