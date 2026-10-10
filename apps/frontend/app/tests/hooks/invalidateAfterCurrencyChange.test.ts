import { describe, expect, test } from 'bun:test';
import { invalidateAfterCurrencyChange } from '../../src/hooks/invalidatePortfolioQueries';

/**
 * The Home hero kept the old currency's total after a base-currency switch
 * until a reload, because it reads `portfolio.*` and the switch refetched
 * everything but that (SC-1530).
 */

type Utils = Parameters<typeof invalidateAfterCurrencyChange>[0];

function recordingUtils(): { utils: Utils; calls: string[] } {
  const calls: string[] = [];
  const router = (name: string) => ({
    invalidate: async (_input: unknown, opts?: { refetchType?: string }) => {
      calls.push(`${name}:${opts?.refetchType ?? 'active'}`);
    },
  });
  const names = [
    'accounts',
    'holdings',
    'institutions',
    'dashboard',
    'vaults',
    'groups',
    'portfolio',
    'transactions',
    'liabilities',
  ];
  const utils = Object.fromEntries(names.map((n) => [n, router(n)])) as unknown as Utils;
  return { utils, calls };
}

describe('invalidateAfterCurrencyChange (SC-1530)', () => {
  test('refetches the portfolio series the Home hero reads', async () => {
    const { utils, calls } = recordingUtils();
    await invalidateAfterCurrencyChange(utils);
    expect(calls).toContain('portfolio:all');
  });

  test('still refetches the dashboard and holdings', async () => {
    const { utils, calls } = recordingUtils();
    await invalidateAfterCurrencyChange(utils);
    expect(calls).toContain('dashboard:all');
    expect(calls).toContain('holdings:all');
  });
});
