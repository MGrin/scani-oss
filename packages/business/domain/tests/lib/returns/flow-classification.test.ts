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

  test('a restated figure is neither a contribution nor a gain', () => {
    expect(flowRoleOf('correction')).toBe('restatement');
  });

  /**
   * The test to delete last.
   *
   * A state that only ever fires is indistinguishable from one that fires on
   * everything, and `restatement` removes a row from BOTH the return and the
   * cashflows — so anything that lands in it by accident is value that
   * vanishes from every figure with nothing to show where it went. The
   * load-bearing evidence is not that `correction` is a restatement; it is
   * that nothing else is.
   *
   * `unknown` is the case a future reader is most likely to argue about,
   * because "we could not classify it" sounds like the same idea. It is not:
   * an unknown row describes a movement that really happened and whose cause
   * we failed to name, and attributing it to the owner's pocket understates
   * the return — the direction a performance figure should fail in (SC-149).
   * A restatement describes a movement that never happened at all.
   */
  test('nothing but a correction is a restatement', () => {
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
      'reward',
      'interest',
      'airdrop',
      'fee',
      'unknown',
      'rebase',
      'slash',
    ]) {
      expect(flowRoleOf(kind)).not.toBe('restatement');
    }
  });
});
