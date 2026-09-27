import { describe, expect, test } from 'bun:test';
import { balanceWithoutClose } from '../../src/lib/balance-without-close';

/**
 * SC-1324: a statement with no balance column created its holding at 0, shown
 * beside the rows it had just imported and a −100% loss. The operator's rule for
 * a holding the import CREATED: its rows are all the evidence there is.
 */
describe('balanceWithoutClose', () => {
  test('a holding the import created takes the sum of its rows', () => {
    // The walk's own file: salary, rent, groceries, coffee, plus a fee row.
    expect(balanceWithoutClose(['3200', '-1100', '-84.20', '-3.50', '-1.50'])).toEqual({
      kind: 'from-rows',
      balance: '2010.8',
    });
  });

  test('a spending-only statement is not stored as a negative balance', () => {
    expect(balanceWithoutClose(['-1100', '-84.20'])).toEqual({ kind: 'unknown' });
  });

  test('rows that net to zero are a real zero, not an unknown', () => {
    expect(balanceWithoutClose(['500', '-500'])).toEqual({ kind: 'from-rows', balance: '0' });
  });

  test('no rows at all is unknown', () => {
    expect(balanceWithoutClose([])).toEqual({ kind: 'unknown' });
  });
});
