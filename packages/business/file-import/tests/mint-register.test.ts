import { describe, expect, it } from 'bun:test';
import { parseMintRegister } from '../src/mint-register';

const HEADER =
  'Date,Description,Original Description,Amount,Transaction Type,Category,Account Name,Labels,Notes';

function parsed(text: string) {
  const result = parseMintRegister(text);
  if (result.kind !== 'parsed') throw new Error(`expected parsed, got ${result.kind}`);
  return result;
}

describe('parseMintRegister', () => {
  it('reads every account in the file, signing each amount by its transaction type', () => {
    const file = [
      HEADER,
      '9/01/2026,Employer,EMPLOYER DIRECT DEP,"4,200.00",credit,Paycheck,Checking,,',
      '9/03/2026,Grocer,GROCER #0001,76.43,debit,Groceries,Card,,weekly',
      '7/21/09,Teavana,TEAVANA #40,3.27,debit,Coffee Shops,Checking,,',
    ].join('\n');

    const result = parsed(file);

    expect(result.currencySymbol).toBeNull();
    expect(result.accounts.map((a) => [a.name, a.rows.length])).toEqual([
      ['Checking', 2],
      ['Card', 1],
    ]);
    const [salary, tea] = result.accounts[0]!.rows;
    expect(salary).toMatchObject({
      amount: '4200',
      payee: 'Employer',
      memo: null,
      category: 'Paycheck',
      cleared: null,
      flag: null,
      transferAccount: null,
      line: 2,
    });
    expect(salary!.date.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(tea!.date.toISOString()).toBe('2009-07-21T00:00:00.000Z');
    expect(result.accounts[1]!.rows[0]).toMatchObject({
      amount: '-76.43',
      memo: 'weekly',
      category: 'Groceries',
    });
  });

  it('skips and counts what it cannot read', () => {
    const file = [
      HEADER,
      '31/12/2026,Grocer,,1.00,debit,,Checking,,',
      '9/03/2026,Grocer,,abc,debit,,Checking,,',
      '9/03/2026,Grocer,,1.00,refund,,Checking,,',
      '9/03/2026,Grocer,,0.00,debit,,Checking,,',
      '9/03/2026,Grocer,,1.00,debit,,,,',
      ',,,,,,,,',
      '9/03/2026,Grocer,,1.00,debit,,Checking,,',
    ].join('\n');

    const result = parsed(file);

    expect(result.skipped).toEqual([
      { line: 2, reason: 'unreadable-date' },
      { line: 3, reason: 'unreadable-amount' },
      { line: 4, reason: 'unreadable-amount' },
      { line: 5, reason: 'zero-amount' },
      { line: 6, reason: 'no-account' },
      { line: 7, reason: 'empty-row' },
    ]);
    expect(result.accounts[0]!.rows).toHaveLength(1);
  });

  it('refuses a file that is not a Mint export, naming the columns it lacks', () => {
    expect(parseMintRegister('Account,Date,Payee,Notes,Amount')).toEqual({
      kind: 'not-a-register',
      missing: ['Description', 'Transaction Type', 'Account Name'],
    });
  });

  it('reads a file saved with a byte-order mark', () => {
    const file = [`﻿${HEADER}`, '9/03/2026,Grocer,,1.00,debit,,Checking,,'].join('\n');

    expect(parsed(file).accounts[0]!.rows).toHaveLength(1);
  });
});
