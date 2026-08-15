import { describe, expect, test } from 'bun:test';
import { SETTLED_QUERY_STATE } from '@scani/ui/v3/lib/query-state';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { AccountsList } from '../../../src/v3/components/entities/AccountsList';
import { InstitutionsList } from '../../../src/v3/components/entities/InstitutionsList';
import { GroupsList } from '../../../src/v3/components/groups/GroupsList';
import { JobsList } from '../../../src/v3/components/jobs/JobsList';
import { ReviewList } from '../../../src/v3/components/review/ReviewList';
import { CustomTokensList, priceOrigin } from '../../../src/v3/components/tokens/CustomTokensList';
import { HiddenHoldingsList } from '../../../src/v3/components/tokens/HiddenHoldingsList';
import { VaultsList } from '../../../src/v3/components/vaults/VaultsList';
import type { AccountRow, InstitutionRow } from '../../../src/v3/lib/accounts';
import type { JobRow } from '../../../src/v3/lib/jobs';
import type { ReviewRow } from '../../../src/v3/lib/review';
import type { HiddenHoldingRow } from '../../../src/v3/lib/tokens';
import type { VaultRow } from '../../../src/v3/lib/vaults';

/**
 * The seven More surfaces, rendered as the phone list.
 *
 * `renderToStaticMarkup` has no `window`, so `useIsDesktop()` resolves false —
 * the surface v3 is designed against. `StaticRouter` is required rather than
 * incidental: `V3DataView` reads the location unconditionally, because a row
 * opens its record at a URL of its own (V3-11).
 *
 * None of these components touches a tRPC hook, which is a design constraint
 * rather than a coincidence: the queries live on the page and the mutations
 * live in leaves reached only from a peek's actions, so every surface stays
 * renderable — and therefore assertable — without a client.
 */

function render(node: React.ReactNode, path = '/v3'): string {
  return renderToStaticMarkup(<StaticRouter location={path}>{node}</StaticRouter>);
}

const REVIEW_ITEMS: ReviewRow[] = [
  {
    id: 'job:parse-1',
    kind: 'screenshot-parse',
    title: 'Document parse',
    subtitle: '2 files',
    href: '/jobs/parse-1',
    createdAt: '2026-08-10T09:00:00.000Z',
  },
];

const JOBS: JobRow[] = [
  {
    jobId: 'parse-1',
    jobName: 'screenshot-parse',
    state: 'completed',
    createdAt: '2026-08-10T09:00:00.000Z',
    actionTakenAt: null,
    payloadSummary: { fileCount: 2 },
  },
  {
    jobId: 'wallet-1',
    jobName: 'wallet-import',
    state: 'failed',
    createdAt: '2026-08-09T09:00:00.000Z',
    actionTakenAt: null,
    payloadSummary: { chain: 'ethereum', address: '0xabc' },
  },
  {
    jobId: 'price-1',
    jobName: 'holding-price-update',
    state: 'active',
    createdAt: '2026-08-11T09:00:00.000Z',
    actionTakenAt: null,
    payloadSummary: null,
  },
];

const ACCOUNTS: AccountRow[] = [
  {
    id: 'acct-fresh',
    name: 'Kraken Spot',
    typeId: 'type-crypto',
    institutionId: 'inst-kraken',
    metadata: { lastSync: new Date().toISOString() },
    summary: { holdingsCount: 4, totalValue: '9000' },
    groups: [{ id: 'g1', name: 'Taxable' }],
  },
  {
    id: 'acct-stale',
    name: 'Old Ledger',
    typeId: 'type-crypto',
    institutionId: 'inst-kraken',
    metadata: { lastSync: '2020-01-01T00:00:00.000Z' },
    summary: { holdingsCount: 1, totalValue: '10' },
    groups: [],
  },
];

const INSTITUTIONS: InstitutionRow[] = [
  {
    id: 'inst-kraken',
    name: 'Kraken',
    description: null,
    website: 'https://kraken.com',
    typeId: 'itype-exchange',
    summary: { accountCount: 2, totalValue: '9010' },
  },
  {
    id: 'inst-manual',
    name: 'Under the mattress',
    description: null,
    website: null,
    typeId: 'itype-other',
    summary: { accountCount: 1, totalValue: '400' },
  },
];

const VAULTS: VaultRow[] = [
  {
    id: 'vault-house',
    name: 'House',
    currentAmount: '2500',
    targetAmount: '10000',
    progress: 25,
    color: '#22c55e',
    currencySymbol: '€',
  },
  {
    id: 'vault-done',
    name: 'Laptop',
    currentAmount: '2200',
    targetAmount: '2000',
    progress: 110,
    color: '#3b82f6',
    currencySymbol: '€',
  },
];

const HIDDEN: HiddenHoldingRow[] = [
  {
    id: 'hold-scam',
    balance: '4000000',
    hiddenReason: 'scam',
    token: { id: 'tok-scam', symbol: 'FREEBTC', name: 'Free BTC Airdrop', isScamProbability: 0.98 },
    account: { id: 'acct-fresh', name: 'Kraken Spot' },
    institution: { id: 'inst-kraken', name: 'Kraken' },
  },
  {
    id: 'hold-mine',
    balance: '12',
    hiddenReason: 'user_hidden',
    token: { id: 'tok-dust', symbol: 'DUST', name: 'Dust', isScamProbability: 0 },
    account: { id: 'acct-fresh', name: 'Kraken Spot' },
    institution: { id: 'inst-kraken', name: 'Kraken' },
  },
];

const noop = () => {};

describe('ReviewList', () => {
  test('renders each waiting item with what it is and how long it has waited', () => {
    const html = render(<ReviewList items={REVIEW_ITEMS} query={SETTLED_QUERY_STATE} />);
    expect(html).toContain('Document parse');
    expect(html).toContain('2 files');
  });

  test('the empty state is an all-clear, not "no items found"', () => {
    const html = render(<ReviewList items={[]} query={SETTLED_QUERY_STATE} />);
    expect(html).toContain('Nothing needs your review');
    // No toolbar over an empty surface: a search box that cannot do anything,
    // sitting above the sentence saying there is nothing to search.
    expect(html).not.toContain('Search review');
  });
});

describe('JobsList', () => {
  test('a completed reviewable job reads as needing review, not as completed', () => {
    const html = render(<JobsList jobs={JOBS} query={SETTLED_QUERY_STATE} />);
    expect(html).toContain('Needs review');
    expect(html).toContain('Failed');
    expect(html).toContain('Active');
  });

  test('carries the payload line that says what the job was pointed at', () => {
    const html = render(<JobsList jobs={JOBS} query={SETTLED_QUERY_STATE} />);
    expect(html).toContain('ethereum · 0xabc');
    expect(html).toContain('2 files');
  });

  test('the needs-review job leads, ahead of the newer running one', () => {
    const html = render(<JobsList jobs={JOBS} query={SETTLED_QUERY_STATE} />);
    expect(html.indexOf('Document parse')).toBeLessThan(html.indexOf('Price refresh'));
  });
});

describe('AccountsList', () => {
  function accountsList(accounts = ACCOUNTS) {
    return (
      <AccountsList
        accounts={accounts}
        currency="$"
        institutions={[{ id: 'inst-kraken', name: 'Kraken', website: 'https://kraken.com' }]}
        accountTypes={[{ id: 'type-crypto', name: 'Crypto' }]}
        groups={[{ id: 'g1', name: 'Taxable' }]}
        defaultFilters={{}}
        query={SETTLED_QUERY_STATE}
        onAssignGroups={noop}
        onBulkDelete={noop}
      />
    );
  }

  test('names the institution behind each account', () => {
    const html = render(accountsList());
    expect(html).toContain('Kraken Spot');
    expect(html).toContain('Kraken · 4 holdings');
  });

  test('an account that has not synced in hours says so on the row', () => {
    const html = render(accountsList());
    expect(html).toContain('Sync overdue');
  });

  test('the summary totals the rows on screen', () => {
    const html = render(accountsList());
    expect(html).toContain('$ 9,010.00');
  });

  test('the empty state invites the import that creates an account', () => {
    const html = render(accountsList([]));
    expect(html).toContain('No accounts yet');
  });
});

describe('InstitutionsList', () => {
  test('shows the account count and the value behind each', () => {
    const html = render(
      <InstitutionsList
        institutions={INSTITUTIONS}
        currency="$"
        types={[{ id: 'itype-exchange', name: 'Exchange' }]}
        query={SETTLED_QUERY_STATE}
      />
    );
    expect(html).toContain('Kraken');
    expect(html).toContain('2 accounts');
    expect(html).toContain('1 account');
  });
});

describe('VaultsList', () => {
  test('a row says how far along the goal is and what is left', () => {
    const html = render(<VaultsList vaults={VAULTS} query={SETTLED_QUERY_STATE} onCreate={noop} />);
    expect(html).toContain('25% of € 10,000');
    expect(html).toContain('to go');
  });

  test('a met vault says so instead of showing a negative remainder', () => {
    const html = render(<VaultsList vaults={VAULTS} query={SETTLED_QUERY_STATE} onCreate={noop} />);
    expect(html).toContain('Target reached');
    expect(html).not.toContain('−€ 200');
  });
});

describe('GroupsList', () => {
  const GROUPS = [
    { id: 'g1', name: 'Taxable', color: '#22c55e', holdingsCount: 12, accountsCount: 1 },
    { id: 'g2', name: 'Empty', color: '#3b82f6', holdingsCount: 0, accountsCount: 0 },
  ];
  const VALUES = [
    { groupId: 'g1', value: '48250.5', holdingsCounted: 12, unpricedSymbols: [] },
    { groupId: 'g2', value: '0', holdingsCounted: 0, unpricedSymbols: [] },
  ];

  function renderGroups(values = VALUES) {
    return render(
      <GroupsList
        groups={GROUPS}
        values={values}
        baseCurrency="EUR"
        query={SETTLED_QUERY_STATE}
        onCreate={noop}
      />
    );
  }

  test('reads out both member counts, singular where it should be', () => {
    const html = renderGroups();
    expect(html).toContain('12 holdings · 1 account');
    expect(html).toContain('0 holdings · 0 accounts');
  });

  /** "1 holdings" is what this row printed until SC-88. The sentence is now
   *  the one the group's own page uses, so the two cannot disagree. */
  test('a group of one reads singular on both nouns', () => {
    const html = render(
      <GroupsList
        groups={[
          { id: 'g3', name: 'House deposit', color: '#eab308', holdingsCount: 1, accountsCount: 1 },
        ]}
        values={[{ groupId: 'g3', value: '10', holdingsCounted: 1, unpricedSymbols: [] }]}
        baseCurrency="EUR"
        query={SETTLED_QUERY_STATE}
        onCreate={noop}
      />
    );
    expect(html).toContain('1 holding · 1 account');
  });

  test('the value zone carries the figure, under a named header', () => {
    const html = renderGroups();
    expect(html).toContain('48,250.50');
    expect(html).toContain('Value');
  });

  /** An empty group is worth zero; one whose every position is unpriceable is
   *  unknown, and printing zero there would understate it by its whole value. */
  test('a group we could price nothing in shows no figure rather than zero', () => {
    const html = renderGroups([
      { groupId: 'g1', value: '0', holdingsCounted: 0, unpricedSymbols: ['NEWCO'] },
      { groupId: 'g2', value: '0', holdingsCounted: 0, unpricedSymbols: [] },
    ]);
    expect(html).toContain('No value');
    expect(html).not.toContain('48,250.50');
  });
});

describe('CustomTokensList', () => {
  test('leads with the price that has gone longest without an update', () => {
    const html = render(
      <CustomTokensList
        tokens={[
          {
            id: 'tok-new',
            symbol: 'NEWCO',
            name: 'Newco Ltd',
            typeCode: 'private-company',
            latestPrice: '120',
            latestPriceBaseCurrency: 'USD',
            latestPriceAt: '2026-08-11T09:00:00.000Z',
            latestPriceSource: 'manual',
          },
          {
            id: 'tok-old',
            symbol: 'OLDCO',
            name: 'Oldco Ltd',
            typeCode: 'private-company',
            latestPrice: '4',
            latestPriceBaseCurrency: 'USD',
            latestPriceAt: '2024-01-01T09:00:00.000Z',
            latestPriceSource: 'manual',
          },
        ]}
        query={SETTLED_QUERY_STATE}
        onCreate={noop}
        onEditPrice={noop}
      />
    );
    expect(html.indexOf('OLDCO')).toBeLessThan(html.indexOf('NEWCO'));
    expect(html).toContain('private company');
  });

  test('a token nobody has ever priced says so rather than showing zero', () => {
    const html = render(
      <CustomTokensList
        tokens={[
          {
            id: 'tok-unpriced',
            symbol: 'GHOST',
            name: 'Ghost',
            typeCode: null,
            latestPrice: null,
            latestPriceBaseCurrency: null,
            latestPriceAt: null,
            latestPriceSource: null,
          },
        ]}
        query={SETTLED_QUERY_STATE}
        onCreate={noop}
        onEditPrice={noop}
      />
    );
    expect(html).toContain('Never priced');
    expect(html).not.toContain('0.00');
  });

  /**
   * SC-77 2. /tokens said `ORBTL · Private Company · — · Never priced` while
   * the holdings peek priced the same token at €14.75 and the home screen
   * called it 8% of net worth. Two lookups over one table: the list asked for
   * the latest MANUAL row, every valuation asks for the latest row of any
   * source, and the nightly downsample had rewritten the manual row's source.
   *
   * The router now runs the valuation's own lookup, so a token with a price is
   * never described as unpriced. What it must not do is launder a provider
   * price into "someone set this by hand" — for a private-company token those
   * are the difference between a mark and a same-symbol accident.
   */
  test('a price the valuation uses is shown, and named for where it came from', () => {
    const html = render(
      <CustomTokensList
        tokens={[
          {
            id: 'tok-orbtl',
            symbol: 'ORBTL',
            name: 'Orbital Ltd',
            typeCode: 'private-company',
            latestPrice: '14.75',
            latestPriceBaseCurrency: 'EUR',
            latestPriceAt: '2026-05-02T09:00:00.000Z',
            latestPriceSource: 'downsample-daily',
          },
        ]}
        query={SETTLED_QUERY_STATE}
        onCreate={noop}
        onEditPrice={noop}
      />,
      '/v3/tokens/tok-orbtl'
    );
    expect(html).toContain('14.75');
    expect(html).not.toContain('Never priced');
  });

  test('the peek names who set the price — a mark and a provider match differ', () => {
    const base = {
      id: 't',
      symbol: 'X',
      name: 'X',
      typeCode: 'private-company',
      latestPrice: '1',
      latestPriceBaseCurrency: 'EUR',
      latestPriceAt: '2026-05-02T09:00:00.000Z',
    };
    expect(priceOrigin({ ...base, latestPriceSource: 'manual' })).toBe('Set manually');
    expect(priceOrigin({ ...base, latestPriceSource: 'coingecko' })).toBe('coingecko');
    expect(priceOrigin({ ...base, latestPriceSource: null })).toBe('Unknown source');
    expect(
      priceOrigin({ ...base, latestPriceAt: null, latestPrice: null, latestPriceSource: null })
    ).toBe('Nothing recorded');
  });
});

describe('HiddenHoldingsList', () => {
  test('says why each holding is hidden, because that decides what you can do', () => {
    const html = render(
      <HiddenHoldingsList holdings={HIDDEN} query={SETTLED_QUERY_STATE} />,
      '/v3/tokens/hidden'
    );
    expect(html).toContain('Likely scam');
    expect(html).toContain('Hidden');
  });

  test('balances carry no currency — a hidden holding is an amount, not a value', () => {
    const html = render(
      <HiddenHoldingsList holdings={HIDDEN} query={SETTLED_QUERY_STATE} />,
      '/v3/tokens/hidden'
    );
    expect(html).toContain('4,000,000');
    expect(html).not.toContain('$4,000,000');
  });
});

/**
 * These eight surfaces spent one release passing `isLoading` to components that
 * had already moved to `query` (V3-16 changed the prop, V3-15 landed after it,
 * and `tests/` is outside the type-check's scope so nothing said so). It was
 * silent because `V3DataView` defaults `query` to `SETTLED_QUERY_STATE`, so the
 * unknown prop was dropped and every assertion above went on passing while
 * testing a surface that could no longer be put into a loading state at all.
 *
 * One surface is enough to hold the wiring — `V3DataView.test.tsx` owns the
 * ramp's own behaviour, and eight copies of this would test that component
 * eight times rather than test the eight call sites. What is checked here is
 * that the prop *arrives*: an un-threaded `query` shows the onboarding empty
 * state during a wait, which is how a slow request reads as an empty account.
 */
describe('the query state reaches the list', () => {
  test('a surface still waiting does not claim the account is empty', () => {
    const waiting = { ...SETTLED_QUERY_STATE, isLoading: true };
    expect(render(<ReviewList items={[]} query={waiting} />)).not.toContain(
      'Nothing needs your review'
    );
    expect(render(<VaultsList vaults={[]} query={waiting} onCreate={noop} />)).not.toContain(
      'No vaults yet'
    );
  });
});
