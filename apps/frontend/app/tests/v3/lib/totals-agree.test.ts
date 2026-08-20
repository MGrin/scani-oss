import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { HoldingWithDetails } from '@scani/shared';
import type { AccountRow } from '../../../src/v3/lib/accounts';
import { accountsValue } from '../../../src/v3/lib/accounts';
import { countsTowardTotal, holdingsValue } from '../../../src/v3/lib/holdings';

/**
 * The three-surface disagreement from SC-63, as arithmetic.
 *
 * Deactivating one holding left `/holdings` reading €599,511.02 and
 * `/`, `/accounts` and `/institutions` all reading €525,728.45 — a €73,782
 * delta that was exactly the deactivated position, and that survived a hard
 * reload. The cause was not a cache: `/accounts` and `/institutions` sum
 * `summary.totalValue`, which the server computes through
 * `PortfolioValuationService` and therefore through `isIncludedInTotal`, while
 * `/holdings` summed every row it had been handed.
 *
 * There is no database here, so the server's half is *modelled*: `serverTotal`
 * applies the same three conditions
 * `packages/business/domain/src/lib/holding-inclusion.ts` applies, which is the
 * contract this test is pinning the client to. If that file's rule changes,
 * this test is where the client finds out.
 */

function holding(overrides: Partial<HoldingWithDetails> = {}): HoldingWithDetails {
  return {
    id: 'h1',
    token: {
      id: 't1',
      symbol: 'BTC',
      name: 'Bitcoin',
      type: 'Crypto',
      typeCode: 'crypto',
      isScamProbability: 0,
    },
    amount: 1,
    value: 100,
    costBasis: 80,
    account: {
      id: 'a1',
      name: 'Spot',
      type: 'Exchange',
      typeCode: 'exchange',
      institutionId: 'i1',
    },
    institution: { id: 'i1', name: 'Kraken', type: 'Exchange', typeCode: 'exchange' },
    groups: [],
    lastUpdated: '2026-08-12T09:00:00.000Z',
    createdAt: '2026-03-03T09:00:00.000Z',
    isActive: true,
    isHidden: false,
    source: 'import_wallet',
    ...overrides,
  };
}

/** `isIncludedInTotal`, restated: hidden, inactive and scam never count. */
function serverIncludes(item: HoldingWithDetails): boolean {
  return !item.isHidden && item.isActive && item.token.isScamProbability < 0.35;
}

/** What `/`, `/accounts` and `/institutions` end up showing: the server sums
 *  the included rows per account, and those figures are what the client adds. */
function accountRowsFor(holdings: readonly HoldingWithDetails[]): AccountRow[] {
  const byAccount = new Map<string, { name: string; total: number; count: number }>();
  for (const item of holdings) {
    const entry = byAccount.get(item.account.id) ?? { name: item.account.name, total: 0, count: 0 };
    entry.count += 1;
    if (serverIncludes(item)) entry.total += item.value ?? 0;
    byAccount.set(item.account.id, entry);
  }
  return [...byAccount.entries()].map(
    ([id, entry]) =>
      ({
        id,
        name: entry.name,
        summary: { totalValue: entry.total.toString(), holdingsCount: entry.count },
      }) as AccountRow
  );
}

const PORTFOLIO = [
  holding({ id: 'h1', value: 525_728.45 }),
  holding({
    id: 'h2',
    value: 73_782.57,
    account: { id: 'a2', name: 'Vault', type: 'Wallet', typeCode: 'wallet', institutionId: 'i2' },
  }),
];

describe('holdings and accounts agree over one portfolio', () => {
  test('before anything is deactivated', () => {
    expect(holdingsValue(PORTFOLIO)).toBeCloseTo(accountsValue(accountRowsFor(PORTFOLIO)), 2);
  });

  test('after a deactivate — the case that shipped the 14% disagreement', () => {
    const after = PORTFOLIO.map((item) => (item.id === 'h2' ? { ...item, isActive: false } : item));

    expect(holdingsValue(after)).toBeCloseTo(525_728.45, 2);
    expect(holdingsValue(after)).toBeCloseTo(accountsValue(accountRowsFor(after)), 2);
  });

  test('the deactivated row is still on the list, so it can be turned back on', () => {
    const after = PORTFOLIO.map((item) => (item.id === 'h2' ? { ...item, isActive: false } : item));
    expect(after).toHaveLength(PORTFOLIO.length);
    expect(after.find((item) => item.id === 'h2')).toBeDefined();
  });
});

describe('the client rule is the server rule', () => {
  const cases = [
    holding(),
    holding({ isActive: false }),
    holding({ isHidden: true }),
    holding({ isActive: false, isHidden: true }),
    holding({ token: { ...holding().token, isScamProbability: 0.9 } }),
    holding({ token: { ...holding().token, isScamProbability: 0.34 } }),
  ];

  test('agrees on every combination of the three conditions', () => {
    for (const item of cases) {
      expect(countsTowardTotal(item)).toBe(serverIncludes(item));
    }
  });
});
