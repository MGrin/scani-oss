import { describe, expect, test } from 'bun:test';
import type { TransactionFetchContext } from '../../../src/core/types';
import { PageCapWatch } from '../../../src/core/utils/page-cap';

function sink(): { ctx: TransactionFetchContext; retractions: string[] } {
  const retractions: string[] = [];
  const ctx = {
    institutionCode: 'stub',
    baseCurrency: { id: 'usd', symbol: 'USD' },
    credentialsRef: { userId: 'u', institutionId: 'i' },
    resolveCredentials: async () => ({}),
    retractHistoryClaim: (reason: string) => {
      retractions.push(reason);
    },
  } as unknown as TransactionFetchContext;
  return { ctx, retractions };
}

describe('PageCapWatch', () => {
  test('a walk that never hit its cap retracts nothing', () => {
    const { ctx, retractions } = sink();
    const watch = new PageCapWatch();
    expect(watch.capped).toBe(false);
    watch.retract(ctx, 'stub');
    expect(retractions).toEqual([]);
  });

  test('one capped walk retracts once, naming the cap and the rows it did return', () => {
    const { ctx, retractions } = sink();
    const watch = new PageCapWatch();
    watch.note({ walk: 'the user-transactions ledger', pages: 200, rows: 200_000 });

    expect(watch.capped).toBe(true);
    watch.retract(ctx, 'bitstamp');

    expect(retractions).toHaveLength(1);
    expect(retractions[0]).toBe(
      'bitstamp: the user-transactions ledger stopped at its 200-page cap after 200000 rows — ' +
        "the rest of this account's history was never fetched"
    );
  });

  test('many capped walks still retract once, naming three and counting the rest', () => {
    const { ctx, retractions } = sink();
    const watch = new PageCapWatch();
    for (let i = 1; i <= 5; i++) {
      watch.note({ walk: `account ${i}`, pages: 200, rows: 20_000 });
    }
    watch.retract(ctx, 'coinbase');

    expect(retractions).toHaveLength(1);
    expect(retractions[0]).toContain('account 1 stopped at its 200-page cap after 20000 rows');
    expect(retractions[0]).toContain('account 3 stopped at its 200-page cap');
    expect(retractions[0]).toContain('2 further walks did the same');
    // The fourth and fifth are counted, not named — a reader learns nothing
    // from the fiftieth capped account.
    expect(retractions[0]).not.toContain('account 4');
  });

  test('a single unnamed walk is counted in the singular', () => {
    const { ctx, retractions } = sink();
    const watch = new PageCapWatch();
    for (let i = 1; i <= 4; i++) watch.note({ walk: `account ${i}`, pages: 50, rows: 1 });
    watch.retract(ctx, 'coinbase');
    expect(retractions[0]).toContain('1 further walk did the same');
  });

  // The retraction channel is optional on the context — a provider called
  // outside `TransactionRouter` has no caller to tell. Capping must not throw
  // there, because the alternative is a paginator that crashes a run it was
  // only trying to annotate.
  test('a context with no retraction channel is survivable', () => {
    const watch = new PageCapWatch();
    watch.note({ walk: 'ledger', pages: 400, rows: 1 });
    expect(() => watch.retract({} as TransactionFetchContext, 'kucoin')).not.toThrow();
  });
});
