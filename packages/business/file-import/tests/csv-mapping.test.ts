import { expect, test } from 'bun:test';
import { parseStatement } from '../src';

test('unknown CSV columns ask before importing and explicit mapping preserves fees and balances', async () => {
  const csv = 'When,What,Change,Unit,After,Cost\n2026-09-24,Coffee,-4,USD,96,0.25';
  const unknown = await parseStatement(csv, 'bank.csv');
  expect(unknown.transactions).toEqual([]);
  expect(unknown.needsColumnMapping?.headers).toContain('When');
  const mapped = await parseStatement(csv, 'bank.csv', {
    customMapping: {
      date: 'When',
      description: 'What',
      amount: 'Change',
      currency: 'Unit',
      balance: 'After',
      fee: 'Cost',
    },
  });
  expect(mapped.needsColumnMapping).toBeUndefined();
  expect(mapped.transactions).toHaveLength(1);
  expect(mapped.transactions[0]).toMatchObject({
    amount: -4,
    currency: 'USD',
    balance: 96,
    fee: 0.25,
  });
});
