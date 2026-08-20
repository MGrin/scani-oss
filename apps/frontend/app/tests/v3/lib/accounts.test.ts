import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import {
  type AccountRow,
  accountBalancesAsOf,
  accountFiltersFromParams,
  accountLastSync,
  accountsValue,
  accountValue,
  balancesAsOfFact,
  compareAccounts,
  compareInstitutions,
  type InstitutionRow,
  institutionsValue,
  institutionValue,
  isStaleSync,
  namedAllocation,
  STALE_SYNC_AFTER_HOURS,
} from '../../../src/v3/lib/accounts';

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'acct-1',
    name: 'Main',
    typeId: 'type-1',
    institutionId: 'inst-1',
    metadata: null,
    summary: { holdingsCount: 3, totalValue: '1200.50' },
    groups: [],
    ...overrides,
  };
}

function institution(overrides: Partial<InstitutionRow> = {}): InstitutionRow {
  return {
    id: 'inst-1',
    name: 'Kraken',
    description: null,
    website: 'https://kraken.com',
    typeId: 'itype-1',
    summary: { accountCount: 2, totalValue: '4000' },
    ...overrides,
  };
}

describe('accountLastSync', () => {
  test('reads the timestamp an integration wrote', () => {
    expect(accountLastSync({ lastSync: '2026-08-10T09:00:00.000Z' })).toBe(
      '2026-08-10T09:00:00.000Z'
    );
  });

  test('a hand-maintained account has none', () => {
    expect(accountLastSync(null)).toBeNull();
    expect(accountLastSync({})).toBeNull();
    expect(accountLastSync('nonsense')).toBeNull();
  });

  test('an empty string is not a timestamp', () => {
    expect(accountLastSync({ lastSync: '' })).toBeNull();
  });
});

describe('isStaleSync', () => {
  const now = Date.parse('2026-08-10T12:00:00.000Z');

  test('is false just inside the threshold', () => {
    const at = new Date(now - (STALE_SYNC_AFTER_HOURS * 60 - 1) * 60 * 1000).toISOString();
    expect(isStaleSync(at, now)).toBe(false);
  });

  test('is true just past it', () => {
    const at = new Date(now - (STALE_SYNC_AFTER_HOURS * 60 + 1) * 60 * 1000).toISOString();
    expect(isStaleSync(at, now)).toBe(true);
  });

  test('never syncing is not overdue — nothing was promised', () => {
    expect(isStaleSync(null, now)).toBe(false);
  });

  test('an unparseable timestamp does not claim staleness', () => {
    expect(isStaleSync('not a date', now)).toBe(false);
  });
});

describe('values', () => {
  test('sums only the rows it is given', () => {
    expect(accountsValue([account(), account({ id: 'a2' })])).toBe(2401);
    expect(accountValue(account({ summary: { holdingsCount: 0, totalValue: 'oops' } }))).toBe(0);
  });

  test('an institution with no summary counts as zero rather than throwing', () => {
    expect(institutionValue(institution({ summary: undefined }))).toBe(0);
    expect(institutionsValue([institution(), institution({ id: 'i2' })])).toBe(8000);
  });
});

describe('namedAllocation', () => {
  test('sorts largest first, because the fold takes the tail', () => {
    const items = [
      { id: 'a', name: 'Small' },
      { id: 'b', name: 'Big' },
    ];
    const allocation = namedAllocation(items, (item) => (item.id === 'b' ? 900 : 10));
    expect(allocation.map((entry) => entry.label)).toEqual(['Big', 'Small']);
    expect(allocation[0]).toEqual({ key: 'b', label: 'Big', value: 900 });
  });
});

describe('accountFiltersFromParams', () => {
  test('picks up the keys a link may set and ignores the rest', () => {
    const params = new URLSearchParams('institution=inst-1&group=g1&nonsense=x&type=');
    expect(accountFiltersFromParams(params)).toEqual({ institution: 'inst-1', group: 'g1' });
  });

  test('no parameters means no seeded filters', () => {
    expect(accountFiltersFromParams(new URLSearchParams(''))).toEqual({});
  });
});

describe('comparators', () => {
  test('accounts sort by value, name and holdings', () => {
    const rich = account({ id: 'rich', summary: { holdingsCount: 1, totalValue: '9000' } });
    const poor = account({
      id: 'poor',
      name: 'Zeta',
      summary: { holdingsCount: 9, totalValue: '1' },
    });
    expect(compareAccounts(rich, poor, 'value', 'desc')).toBeLessThan(0);
    expect(compareAccounts(rich, poor, 'name', 'asc')).toBeLessThan(0);
    expect(compareAccounts(rich, poor, 'holdings', 'desc')).toBeGreaterThan(0);
    expect(compareAccounts(rich, poor, 'unknown', 'asc')).toBe(0);
  });

  test('institutions sort by value, name and account count', () => {
    const big = institution({ id: 'big', summary: { accountCount: 1, totalValue: '9000' } });
    const small = institution({
      id: 'small',
      name: 'Zeta',
      summary: { accountCount: 5, totalValue: '10' },
    });
    expect(compareInstitutions(big, small, 'value', 'desc')).toBeLessThan(0);
    expect(compareInstitutions(big, small, 'accounts', 'desc')).toBeGreaterThan(0);
    expect(compareInstitutions(big, small, 'unknown', 'asc')).toBe(0);
  });
});

/**
 * SC-384 — the second claim on an account, next to `lastSync`.
 *
 * Every guard here is about refusing to render half a fact. A date with no
 * reason reads as "your data is old" and leaves the reader to decide whether
 * it is also wrong; that decision is what made a correct IBKR sync look like
 * a broken integration in the first place.
 */
describe('accountBalancesAsOf', () => {
  const NOTE = 'Interactive Brokers generates this statement after the close.';

  test('reads the pair the sync writes', () => {
    expect(
      accountBalancesAsOf({ balancesAsOf: { at: '2026-08-16T23:59:59.000Z', note: NOTE } })
    ).toEqual({ at: '2026-08-16T23:59:59.000Z', note: NOTE });
  });

  test('a live-balance account has nothing to say', () => {
    expect(accountBalancesAsOf({ lastSync: '2026-08-17T15:10:52.000Z' })).toBeNull();
  });

  test.each([
    ['no note', { balancesAsOf: { at: '2026-08-16T23:59:59.000Z' } }],
    ['empty note', { balancesAsOf: { at: '2026-08-16T23:59:59.000Z', note: '' } }],
    ['no date', { balancesAsOf: { note: NOTE } }],
    ['unparseable date', { balancesAsOf: { at: 'yesterday-ish', note: NOTE } }],
    ['wrong shape', { balancesAsOf: 'soon' }],
  ])('%s renders nothing rather than half a fact', (_label, metadata) => {
    expect(accountBalancesAsOf(metadata)).toBeNull();
  });

  test('a missing metadata column is not an error', () => {
    expect(accountBalancesAsOf(undefined)).toBeNull();
    expect(accountBalancesAsOf(null)).toBeNull();
    expect(accountBalancesAsOf('nonsense')).toBeNull();
  });
});

describe('balancesAsOfFact', () => {
  const NOTE = 'Interactive Brokers generates this statement after the close.';

  test('the date and the reason are one string, never two facts', () => {
    // A layout that could show one without the other is the pre-SC-384 screen
    // again, with a date on it.
    const fact = balancesAsOfFact({ balancesAsOf: { at: '2026-08-16T23:59:59.000Z', note: NOTE } });
    expect(fact).toContain(NOTE);
    expect(fact).toContain('2026');
  });

  test('null for a live-balance account, so the peek omits the row entirely', () => {
    expect(balancesAsOfFact({ lastSync: '2026-08-17T15:10:52.000Z' })).toBeNull();
    expect(balancesAsOfFact(undefined)).toBeNull();
  });
});
