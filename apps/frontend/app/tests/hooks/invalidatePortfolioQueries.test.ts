import { describe, expect, test } from 'bun:test';
import { invalidatePortfolioQueries } from '../../src/hooks/invalidatePortfolioQueries';

/**
 * A portfolio write refreshes the ledger it wrote to (SC-1527).
 *
 * Recording a movement writes `holding_transactions` rows, and the holding
 * peek lists them through `transactions.list`. Without the transactions router
 * in this set the peek kept its cached list after the write, so the movement
 * the reader had just recorded appeared only after a reload.
 */

function recordingUtils() {
  const invalidated: string[] = [];
  const router = (name: string) => ({
    invalidate: async () => {
      invalidated.push(name);
    },
  });
  const utils = new Proxy(
    {},
    { get: (_target, name) => router(String(name)) }
  ) as unknown as Parameters<typeof invalidatePortfolioQueries>[0];
  return { utils, invalidated };
}

describe('invalidatePortfolioQueries', () => {
  test('refreshes the transaction list a recorded movement adds to', async () => {
    const { utils, invalidated } = recordingUtils();
    await invalidatePortfolioQueries(utils);
    expect(invalidated).toContain('transactions');
  });

  test('still refreshes the holdings and accounts the movement changed', async () => {
    const { utils, invalidated } = recordingUtils();
    await invalidatePortfolioQueries(utils);
    expect(invalidated).toEqual(expect.arrayContaining(['holdings', 'accounts', 'dashboard']));
  });
});
