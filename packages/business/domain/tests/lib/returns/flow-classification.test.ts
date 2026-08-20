import { describe, expect, test } from 'bun:test';
import { flowRoleOf } from '../../../src/lib/returns/flow-classification';

describe('flowRoleOf', () => {
  test('money the owner put in or took out is external', () => {
    for (const kind of [
      'buy',
      'sell',
      'deposit',
      'withdraw',
      'transfer_in',
      'transfer_out',
      'swap_in',
      'swap_out',
      'opening_balance',
    ]) {
      expect(flowRoleOf(kind)).toBe('external');
    }
  });

  test('value the portfolio produced or consumed is return', () => {
    for (const kind of ['reward', 'interest', 'airdrop', 'fee']) {
      expect(flowRoleOf(kind)).toBe('return');
    }
  });

  test("a kind nobody classified counts as the owner's money, not as skill", () => {
    expect(flowRoleOf('unknown')).toBe('external');
    // The schema says readers must tolerate kinds that do not exist yet.
    expect(flowRoleOf('rebase')).toBe('external');
    expect(flowRoleOf('slash')).toBe('external');
  });
});
