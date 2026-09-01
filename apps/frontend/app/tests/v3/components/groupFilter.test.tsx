import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { HoldingWithDetails } from '@scani/shared';
import i18n from 'i18next';
import { holdingsDataViewConfig } from '../../../src/v3/components/holdings/holdingsConfig';
import { holdingsValue } from '../../../src/v3/lib/holdings';

/**
 * SC-385, and still the same pin after SC-386. `/holdings?group=<id>` is what
 * an allocation row on the dashboard opens, and the figure it puts at the top
 * has to be the figure the row was showing. They disagreed materially on
 * production for weeks because the two sides answered "who is in this group"
 * differently: the card unioned `holding_groups` with the `account_groups`
 * cache, the list read the row's own `groups`. The server answers it once now
 * (`GroupValuationService` → `GroupRepository.findGroupsForHoldings`), and its
 * own test pins the arithmetic to a written-out copy of the two functions
 * below.
 *
 * SC-386 reversed what that one answer IS — membership became the account's
 * standing rule minus a per-holding veto, so a row's `groups` now carries what
 * its account puts it in — and deliberately did NOT touch this filter. That is
 * the point: resolution belongs to the server, and the day the client starts
 * deriving membership of its own is the day the two can disagree again.
 *
 * So this still fails if the filter ever selects on anything but the row's own
 * `groups` — reaching for `item.account` here being the exact change that
 * would re-open the gap, and one nothing on the server side could see.
 */

const GROUP = { id: 'g-liquid', name: 'Liquid', color: '#3b82f6' };

function holding(overrides: Partial<HoldingWithDetails> = {}): HoldingWithDetails {
  return {
    id: 'h1',
    token: {
      id: 't1',
      symbol: 'USD',
      name: 'US Dollar',
      type: 'Fiat',
      typeCode: 'fiat',
      isScamProbability: 0,
      lookalikeOf: null,
    },
    amount: '1',
    value: 1,
    costBasis: 1,
    account: { id: 'a1', name: 'Airwallex', type: 'Bank', typeCode: 'bank', institutionId: 'i1' },
    institution: { id: 'i1', name: 'Airwallex', type: 'Bank', typeCode: 'bank' },
    groups: [],
    lastUpdated: '2026-08-18T04:00:00.000Z',
    createdAt: '2026-06-28T09:00:00.000Z',
    isActive: true,
    isHidden: false,
    source: 'import_wallet',
    ...overrides,
  };
}

function groupFilter(holdings: HoldingWithDetails[]) {
  const config = holdingsDataViewConfig({
    holdings,
    currency: 'USD',
    institutions: undefined,
    accounts: undefined,
    // SC-293 made this required after this test was written (SC-385). The
    // group filter has nothing to do with data quality, so an absent set is
    // the honest fixture: no row is in any quality set.
    qualitySets: undefined,
    groups: [GROUP],
    defaultFilters: {},
    peek: {} as never,
    onAssignGroups: () => {},
    onBulkDelete: () => {},
    isBulkDeleting: false,
    onAddData: () => {},
    t: i18n.t.bind(i18n),
  });
  const def = config.filterDefs?.find((entry) => entry.key === 'group');
  const fn = def?.fn;
  if (!fn) throw new Error('the holdings list has no group filter');
  return (value: string) => holdings.filter((item) => fn(item, value));
}

describe('the holdings list, filtered to one group', () => {
  test('selects on the row own groups, whatever put them there', () => {
    const inGroup = holding({ id: 'h-old', value: 46805.3, groups: [GROUP] });
    // The Airwallex holding that arrived after the account joined the group.
    // Under SC-386 the server resolves it into the group by the account's
    // standing rule, so it reaches the client already carrying it — and the
    // list totals 53,024.05, the same figure the card now shows.
    const arrivedLater = holding({ id: 'h-new', value: 6218.75, groups: [GROUP] });

    const filter = groupFilter([inGroup, arrivedLater]);

    expect(filter(GROUP.id).map((item) => item.id)).toEqual(['h-old', 'h-new']);
    expect(holdingsValue(filter(GROUP.id))).toBe(53024.05);
  });

  test('a holding vetoed out of the group is not selected, though its sibling is', () => {
    const inGroup = holding({ id: 'h-old', value: 46805.3, groups: [GROUP] });
    // Same account, in the group by no measure the client can see: the veto is
    // resolved server-side and arrives as an absent group, which is exactly
    // why the client must not re-derive membership from the account.
    const vetoed = holding({ id: 'h-dust', value: 0.02, groups: [] });

    const filter = groupFilter([inGroup, vetoed]);

    expect(filter(GROUP.id).map((item) => item.id)).toEqual(['h-old']);
    expect(holdingsValue(filter(GROUP.id))).toBe(46805.3);
  });

  test('a holding in several groups is selected by each of them', () => {
    const other = { id: 'g-long', name: 'Long term', color: '#a855f7' };
    const both = holding({ id: 'h-both', value: 100, groups: [GROUP, other] });

    const filter = groupFilter([both, holding({ id: 'h-none', value: 7 })]);

    expect(filter(GROUP.id).map((item) => item.id)).toEqual(['h-both']);
    expect(filter(other.id).map((item) => item.id)).toEqual(['h-both']);
  });
});
