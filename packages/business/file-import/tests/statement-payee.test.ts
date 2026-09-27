import { describe, expect, test } from 'bun:test';
import { statementPayee } from '../src/statement-payee';

describe('statementPayee', () => {
  test('one payee across months gives one value, whatever dates and refs ride along', () => {
    expect(statementPayee('RENT SEP 2026 #4411')).toBe('RENT');
    expect(statementPayee('RENT OCT')).toBe('RENT');
    expect(statementPayee('RENT 01/11/2026 REF 99812')).toBe('RENT');
  });

  test('card and terminal numbers, amounts and processor wording are dropped', () => {
    expect(statementPayee('TESCO STORES 2231')).toBe('TESCO STORES');
    expect(statementPayee('CARD PAYMENT TO TESCO STORES 2231 ON 05/09')).toBe('TESCO STORES');
    expect(statementPayee('COFFEE CO 3.50 EUR')).toBe('COFFEE CO');
  });

  test('a description that is only bank wording names nobody', () => {
    expect(statementPayee('CARD PAYMENT')).toBeNull();
    expect(statementPayee('ATM WITHDRAWAL 02/09 12:30')).toBeNull();
    expect(statementPayee('TRANSFER 4411')).toBeNull();
  });

  test('no description names nobody', () => {
    expect(statementPayee(undefined)).toBeNull();
    expect(statementPayee('')).toBeNull();
    expect(statementPayee('  #4411 02/09/2026 ')).toBeNull();
  });

  test('case is kept, so the value reads as the bank printed it', () => {
    expect(statementPayee('Netflix.com 12.99')).toBe('Netflix.com');
  });
});
