import { describe, expect, it } from 'bun:test';
import { detectBudgetApp, parseBudgetAppRegister } from '../src/budget-app-register';

const YNAB =
  '﻿"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"\n"Checking","","2026-08-14","Grocer","","","","","$1.00","$0.00","Cleared"';
const YNAB_TSV =
  'Account\tDate\tPayee\tMemo\tOutflow\tInflow\nChecking\t14.08.2026\tGrocer\t\t1,00€\t0,00€';
const ACTUAL =
  'Account,Date,Payee,Notes,Category_Group,Category,Amount,Split_Amount,Cleared\nChecking,2026-08-14,Grocer,,,,-1,0,Cleared';

const MINT =
  'Date,Description,Original Description,Amount,Transaction Type,Category,Account Name,Labels,Notes\n9/03/2026,Grocer,,1.00,debit,,Checking,,';

describe('detectBudgetApp', () => {
  it('names the app from the header row', () => {
    expect(detectBudgetApp(YNAB)).toBe('ynab');
    expect(detectBudgetApp(YNAB_TSV)).toBe('ynab');
    expect(detectBudgetApp(ACTUAL)).toBe('actual');
    // Mint's header also has Amount and Notes, so it must not read as Actual.
    expect(detectBudgetApp(MINT)).toBe('mint');
  });

  it('is null for a file neither app wrote', () => {
    expect(detectBudgetApp('Date,Description,Amount\n2026-08-14,Grocer,-1')).toBeNull();
    expect(detectBudgetApp('')).toBeNull();
  });
});

describe('parseBudgetAppRegister', () => {
  it("reads each app's file with that app's parser", () => {
    const ynab = parseBudgetAppRegister(YNAB, 'ynab');
    const actual = parseBudgetAppRegister(ACTUAL, 'actual');

    expect(ynab.kind === 'parsed' && ynab.accounts[0]!.rows[0]!.amount).toBe('-1');
    expect(actual.kind === 'parsed' && actual.accounts[0]!.rows[0]!.amount).toBe('-1');
    const mint = parseBudgetAppRegister(MINT, 'mint');
    expect(mint.kind === 'parsed' && mint.accounts[0]!.rows[0]!.amount).toBe('-1');
    expect(parseBudgetAppRegister(ACTUAL, 'ynab').kind).toBe('not-a-register');
  });
});
