import { describe, expect, test } from 'bun:test';
import { ALLOCATION_OTHER_KEY } from '@scani/ui/v3/lib/chart';
import {
  ALLOCATION_DIMENSION_KEYS,
  ALLOCATION_DIMENSIONS,
  allocationHref,
  allocationItems,
  DEFAULT_ALLOCATION_DIMENSION,
  DEFAULT_HOME_PERIOD,
  type FigureQuality,
  foldedAllocationItems,
  formatDueIn,
  groupRows,
  HOME_METRIC_KEYS,
  HOME_METRICS,
  HOME_PERIOD_KEYS,
  HOME_PERIODS,
  heroDeltaState,
  homePeriodByKey,
  homePeriodRange,
  lastMeasuredBeforeToday,
  latestMeasured,
  latestPnl,
  latestPnlSource,
  type NetWorthPoint,
  netWorthChartPoints,
  nextPayments,
  type PnLPoint,
  periodRange,
  type QualityPoint,
  qualityHeadline,
  qualityOmissions,
  rebasePnlSeries,
  resolvePeriodDelta,
  sparklineSeries,
  summariseQuality,
  topHoldingRows,
  type UpcomingOccurrence,
  unreviewedTransfersNote,
  vaultRows,
} from '../../../src/v3/lib/home';

/** A day the rollup priced every holding on. */
function covered(date: string, totalValue: string): NetWorthPoint {
  return { date, totalValue, holdingsWithKnownValue: 4, holdingsTotal: 4 };
}

/**
 * A day the rollup priced nothing on. The rollup still writes `totalValue: '0'`
 * for these — that string is the whole defect SC-66 is about.
 */
function uncovered(date: string): NetWorthPoint {
  return { date, totalValue: '0', holdingsWithKnownValue: 0, holdingsTotal: 0 };
}

const SERIES = [
  covered('2026-07-13', '120000'),
  covered('2026-07-28', '124500'),
  covered('2026-08-11', '127800'),
];

describe('periods', () => {
  test('an unknown key falls back to the default rather than rendering nothing', () => {
    expect(homePeriodByKey('nonsense')).toBe(DEFAULT_HOME_PERIOD);
    expect(homePeriodByKey('7d').days).toBe(7);
  });

  test('the range ends now and reaches back the period', () => {
    const now = new Date('2026-08-12T09:00:00Z');
    const { from, to } = periodRange(homePeriodByKey('30d'), now);
    expect(to).toEqual(now);
    expect(from.toISOString()).toBe('2026-07-13T09:00:00.000Z');
  });

  test('the same period asked for twice in a day is the same window', () => {
    // The window IS the query key. Two callers computing it milliseconds apart
    // produced two keys and two requests, which is why the series could not be
    // asked for before `HeroBlock` mounted (SC-164) — and why the 30s
    // `staleTime` never applied across a remount.
    const period = homePeriodByKey('30d');
    const first = homePeriodRange(period, new Date('2026-08-12T09:00:00Z'));
    const second = homePeriodRange(period, new Date('2026-08-12T23:59:00Z'));
    expect(second).toBe(first);
  });

  test('it re-pins the next day, so a tab left open does not chart yesterday', () => {
    const period = homePeriodByKey('90d');
    const today = homePeriodRange(period, new Date('2026-08-12T09:00:00Z'));
    const tomorrow = homePeriodRange(period, new Date('2026-08-13T09:00:00Z'));
    expect(tomorrow).not.toBe(today);
    expect(tomorrow.to.toISOString()).toBe('2026-08-13T09:00:00.000Z');
  });

  test('two periods do not share a window', () => {
    const at = new Date('2026-08-12T09:00:00Z');
    expect(homePeriodRange(homePeriodByKey('7d'), at).from).not.toEqual(
      homePeriodRange(homePeriodByKey('365d'), at).from
    );
  });
});

describe('resolvePeriodDelta', () => {
  test('measures the live total against the first point in the window', () => {
    // Not against the series' own last point: the rollup lands a day behind,
    // so the headline and the delta would disagree.
    const delta = resolvePeriodDelta(SERIES, '128432.10');
    expect(delta?.absolute).toBeCloseTo(8432.1, 2);
    expect(delta?.percent).toBeCloseTo(7.0268, 3);
  });

  test('a window with no history reports nothing rather than zero', () => {
    expect(resolvePeriodDelta([], '128432.10')).toBeNull();
    expect(resolvePeriodDelta([SERIES[0] as NetWorthPoint], '1')).toBeNull();
  });

  test('a zero baseline has an absolute change but no ratio', () => {
    const delta = resolvePeriodDelta(
      [covered('2026-07-13', '0'), covered('2026-08-11', '500')],
      '900'
    );
    expect(delta?.absolute).toBe(900);
    expect(delta?.percent).toBeNull();
  });

  test('an unknown total is not a delta of minus everything', () => {
    expect(resolvePeriodDelta(SERIES, null)).toBeNull();
  });

  /**
   * The headline defect of SC-66: the window opened on a day the rollup priced
   * nothing on and wrote `0` for, so the delta read "+128k, +∞%" on a portfolio
   * that had gained 8k.
   */
  test('the baseline skips a day we priced nothing on', () => {
    const delta = resolvePeriodDelta([uncovered('2026-07-12'), ...SERIES], '128432.10');
    expect(delta?.absolute).toBeCloseTo(8432.1, 2);
    expect(delta?.percent).toBeCloseTo(7.0268, 3);
  });

  test('a window of nothing but uncovered days has no delta at all', () => {
    expect(
      resolvePeriodDelta([uncovered('2026-07-12'), uncovered('2026-07-13')], '128432.10')
    ).toBeNull();
  });
});

describe('sparklineSeries', () => {
  test('ends on the live total so the glyph agrees with the hero', () => {
    expect(sparklineSeries(SERIES, '128432.10')).toEqual([120000, 124500, 127800, 128432.1]);
  });

  test('drops points that are not numbers rather than plotting them as zero', () => {
    expect(
      sparklineSeries(
        [{ date: '2026-08-11', totalValue: 'n/a', holdingsWithKnownValue: 4, holdingsTotal: 4 }],
        100
      )
    ).toEqual([100]);
  });

  test('a day we priced nothing on is dropped, not drawn at the floor', () => {
    expect(sparklineSeries([SERIES[0] as NetWorthPoint, uncovered('2026-07-20')], null)).toEqual([
      120000,
    ]);
  });
});

describe('allocationItems', () => {
  test('biggest first, and non-positive parts are dropped', () => {
    expect(
      allocationItems(
        [
          { id: 'stock', name: 'Stocks', value: '31000' },
          { id: 'crypto', name: 'Crypto', value: '52000' },
          { id: 'debt', name: 'Debt', value: '-4000' },
          { id: 'nft', name: 'NFTs', value: '0' },
        ],
        'token_type'
      )
    ).toEqual([
      { key: 'crypto', label: 'Crypto', value: 52000 },
      { key: 'stock', label: 'Stocks', value: 31000 },
    ]);
  });

  /**
   * The key is the row's `id`, not its `code`. Cut by group, `code` is the
   * group's *name*, which two groups may share and which changes when the user
   * renames one — either would silently merge two parts of the bar into one
   * segment or repaint the whole thing.
   */
  test('two parts sharing a code stay two segments', () => {
    expect(
      allocationItems(
        [
          { id: 'a', code: 'Savings', name: 'Savings', value: '10' },
          { id: 'b', code: 'Savings', name: 'Savings', value: '5' },
        ],
        'group'
      ).map((item) => item.key)
    ).toEqual(['a', 'b']);
  });

  /**
   * The type cut is the exception, and it is the one that would have shipped
   * broken: `AssetAllocationService` sets a type row's `id` to the token type's
   * uuid while the holdings list filters on its *code*, so keying by `id` gives
   * every type row a link to an empty list (SC-74).
   */
  test('the type cut is keyed by the code the holdings filter matches', () => {
    expect(
      allocationItems(
        [{ id: '6f0e-uuid', code: 'crypto', name: 'Crypto', value: '10' }],
        'token_type'
      ).map((item) => item.key)
    ).toEqual(['crypto']);
  });
});

describe('allocationHref', () => {
  test.each([
    ['token_type', 'crypto', '/holdings?tokenType=crypto'],
    ['institution', 'inst-1', '/holdings?institution=inst-1'],
    ['account', 'acct-1', '/holdings?account=acct-1'],
    ['group', 'grp-1', '/holdings?group=grp-1'],
  ] as const)('the %s cut opens the holdings list filtered to the slice', (dimension, key, href) => {
    expect(allocationHref(dimension, key)).toBe(href);
  });

  test('an id needing escaping is escaped rather than mangling the query', () => {
    expect(allocationHref('account', 'a b&c')).toBe('/holdings?account=a%20b%26c');
  });

  // Two rows stand for no record, and a link on either lands on an empty list:
  // the bar's fold, and the synthetic row the group cut adds for everything
  // belonging to no group at all.
  test('the fold is not a record', () => {
    expect(allocationHref('institution', ALLOCATION_OTHER_KEY)).toBeNull();
  });

  test('ungrouped is not a group', () => {
    expect(allocationHref('group', 'ungrouped')).toBeNull();
    // Only on the group cut — an account genuinely named "ungrouped" by its id
    // is a record like any other.
    expect(allocationHref('account', 'ungrouped')).toBe('/holdings?account=ungrouped');
  });
});

function occurrence(id: string, dueDate: string): UpcomingOccurrence {
  return {
    id,
    dueDate,
    expectedAmount: '42.00',
    actualAmount: null,
    payment: { id: `p-${id}`, vendorId: 'v', currencyTokenId: 't', direction: 'outflow' },
  };
}

describe('nextPayments', () => {
  test('drops what is already overdue and takes the soonest', () => {
    const rows = nextPayments(
      [
        occurrence('late', '2026-07-01'),
        occurrence('third', '2026-09-02'),
        occurrence('first', '2026-08-12'),
        occurrence('second', '2026-08-20'),
        occurrence('fourth', '2026-09-09'),
      ],
      '2026-08-12',
      3
    );
    expect(rows.map((row) => row.id)).toEqual(['first', 'second', 'third']);
  });
});

describe('formatDueIn', () => {
  test.each([
    ['2026-08-12', 'Today'],
    ['2026-08-13', 'Tomorrow'],
    ['2026-08-21', 'in 9 days'],
    ['2026-09-02', 'in 3 weeks'],
    ['2026-11-10', 'in 3 months'],
  ])('%s reads as %s', (dueDate, expected) => {
    expect(formatDueIn(dueDate, '2026-08-12')).toBe(expected);
  });

  test('an overdue row that slipped through still reads as due now', () => {
    expect(formatDueIn('2026-08-01', '2026-08-12')).toBe('Today');
  });

  test('the difference is taken in UTC, not in the local zone', () => {
    // Both ends parse as midnight UTC, so the answer cannot change with the
    // machine's timezone — which is what `payments.upcoming` compares on.
    expect(formatDueIn('2026-08-14', '2026-08-12')).toBe('in 2 days');
  });
});

/**
 * SC-111. The line under the hero has four states and only one of them is a
 * claim about the reader's account; the other three are claims about us.
 */
describe('heroDeltaState', () => {
  test('a series still loading is not an account with no history', () => {
    expect(heroDeltaState({ hasDelta: false, isLoading: true, hasFailed: false })).toBe('loading');
  });

  test('loading outranks failed, so a retry is not offered mid-request', () => {
    expect(heroDeltaState({ hasDelta: false, isLoading: true, hasFailed: true })).toBe('loading');
  });

  test('a failed series is not an empty one either', () => {
    expect(heroDeltaState({ hasDelta: false, isLoading: false, hasFailed: true })).toBe('failed');
  });

  test('"no history" is said only once nothing else can explain the absence', () => {
    expect(heroDeltaState({ hasDelta: false, isLoading: false, hasFailed: false })).toBe('empty');
  });

  test('a delta already in hand survives a background refetch', () => {
    expect(heroDeltaState({ hasDelta: true, isLoading: true, hasFailed: false })).toBe('delta');
  });
});

describe('netWorthChartPoints', () => {
  test('ends on the live total so the curve agrees with the hero above it', () => {
    expect(netWorthChartPoints(SERIES, '128432.10', '2026-08-12')).toEqual([
      { date: '2026-07-13', value: 120000 },
      { date: '2026-07-28', value: 124500 },
      { date: '2026-08-11', value: 127800 },
      { date: '2026-08-12', value: 128432.1 },
    ]);
  });

  test("today's rolled-up point is replaced, not doubled", () => {
    // Two points on one date draw a vertical step at the right edge.
    const rolled = [...SERIES, covered('2026-08-12', '127900')];
    const points = netWorthChartPoints(rolled, '128432.10', '2026-08-12');
    expect(points).toHaveLength(4);
    expect(points.at(-1)).toEqual({ date: '2026-08-12', value: 128432.1 });
  });

  test('an unknown total leaves the rollup curve as it is', () => {
    expect(netWorthChartPoints(SERIES, null, '2026-08-12')).toHaveLength(3);
  });

  test('a point that is not a number keeps its date and carries no value', () => {
    expect(
      netWorthChartPoints(
        [{ date: '2026-08-11', totalValue: 'n/a', holdingsWithKnownValue: 4, holdingsTotal: 4 }],
        null,
        '2026-08-12'
      )
    ).toEqual([{ date: '2026-08-11', value: null }]);
  });

  /**
   * The chart half of SC-66. `connectNulls={false}` turns the null into a break
   * in the line; the `0` the rollup wrote turned it into a plunge to the floor
   * and a spike back, on a portfolio that had not moved.
   */
  test('a day we priced nothing on breaks the line instead of diving to zero', () => {
    const points = netWorthChartPoints(
      [SERIES[0] as NetWorthPoint, uncovered('2026-07-20'), SERIES[1] as NetWorthPoint],
      null,
      '2026-08-12'
    );
    expect(points).toEqual([
      { date: '2026-07-13', value: 120000 },
      { date: '2026-07-20', value: null },
      { date: '2026-07-28', value: 124500 },
    ]);
  });
});

/**
 * SC-115. The user-wide series stopped carrying uncovered days when SC-98
 * moved the coverage filter to the source, and on a category axis a dropped
 * day is not a gap — it is a day that never existed, so the line runs straight
 * through it.
 */
describe('netWorthChartPoints — days the server dropped', () => {
  test('an unmeasured day breaks the line instead of being drawn through', () => {
    const points = netWorthChartPoints(
      [SERIES[0] as NetWorthPoint, SERIES[1] as NetWorthPoint],
      null,
      '2026-08-12',
      ['2026-07-14', '2026-07-15']
    );
    expect(points).toEqual([
      { date: '2026-07-13', value: 120000 },
      { date: '2026-07-14', value: null },
      { date: '2026-07-15', value: null },
      { date: '2026-07-28', value: 124500 },
    ]);
  });

  test('a date the series already carries is not doubled by the gap list', () => {
    const points = netWorthChartPoints([SERIES[0] as NetWorthPoint], null, '2026-08-12', [
      '2026-07-13',
    ]);
    expect(points).toEqual([{ date: '2026-07-13', value: 120000 }]);
  });

  test("the live total still lands on today, on top of today's gap", () => {
    const points = netWorthChartPoints([SERIES[0] as NetWorthPoint], '130000', '2026-07-15', [
      '2026-07-14',
      '2026-07-15',
    ]);
    expect(points).toEqual([
      { date: '2026-07-13', value: 120000 },
      { date: '2026-07-14', value: null },
      { date: '2026-07-15', value: 130000 },
    ]);
  });
});

describe('lastMeasuredBeforeToday', () => {
  test('names the last measured day when the gap runs up to today', () => {
    const points = netWorthChartPoints([SERIES[0] as NetWorthPoint], '130000', '2026-07-15', [
      '2026-07-14',
      '2026-07-15',
    ]);
    expect(lastMeasuredBeforeToday(points, '2026-07-15')).toBe('2026-07-13');
  });

  test('says nothing when the rollup runs up to today', () => {
    const points = netWorthChartPoints(SERIES, '130000', '2026-08-12');
    expect(lastMeasuredBeforeToday(points, '2026-08-12')).toBeNull();
  });

  /** A break with measurements after it is visible on its own. */
  test('says nothing about a gap in the middle of the window', () => {
    const points = netWorthChartPoints(
      [SERIES[0] as NetWorthPoint, SERIES[2] as NetWorthPoint],
      '130000',
      '2026-08-12',
      ['2026-07-20']
    );
    expect(lastMeasuredBeforeToday(points, '2026-08-12')).toBeNull();
  });

  test('says nothing when there is no measurement at all', () => {
    expect(lastMeasuredBeforeToday([{ date: '2026-08-12', value: 5 }], '2026-08-12')).toBeNull();
  });
});

function pnlPoint(
  date: string,
  realizedPnl: string | null,
  unrealizedPnl: string | null,
  totalPnl: string | null
): PnLPoint {
  return {
    date,
    realizedPnl,
    unrealizedPnl,
    totalPnl,
    holdingsWithKnownValue: 4,
    holdingsTotal: 4,
    holdingsUnpriceable: 0,
    holdingsBasisUnknown: 0,
    holdingsStalePriced: 0,
  };
}

const PNL = [
  pnlPoint('2026-07-13', '100', '400', '500'),
  pnlPoint('2026-07-28', '150', '650', '800'),
  pnlPoint('2026-08-11', '150', '250', '400'),
];

describe('rebasePnlSeries', () => {
  test('the window starts at zero, so the period selector drives the curve', () => {
    expect(rebasePnlSeries(PNL)).toEqual([
      { date: '2026-07-13', total: 0, realized: 0, unrealized: 0 },
      { date: '2026-07-28', total: 300, realized: 50, unrealized: 250 },
      { date: '2026-08-11', total: -100, realized: 50, unrealized: -150 },
    ]);
  });

  test('total stays the sum of its two components after the shift', () => {
    for (const point of rebasePnlSeries(PNL)) {
      expect(point.total).toBe((point.realized ?? 0) + (point.unrealized ?? 0));
    }
  });

  test('days the rollup has not computed stay null rather than becoming zero', () => {
    const withGap = [pnlPoint('2026-08-01', null, null, null), ...PNL];
    expect(rebasePnlSeries(withGap)[0]).toEqual({
      date: '2026-08-01',
      total: null,
      realized: null,
      unrealized: null,
    });
  });

  test('a series with no computed point at all is passed through, not zeroed', () => {
    expect(rebasePnlSeries([pnlPoint('2026-08-01', null, null, null)])).toEqual([
      { date: '2026-08-01', total: null, realized: null, unrealized: null },
    ]);
  });

  /**
   * On a day nothing was priced the rollup's unrealized PnL is `0 − costBasis`.
   * Plotted, that is a total loss the user never took, in the same spot the
   * net-worth curve dives to zero.
   */
  test('a day we priced nothing on carries no PnL, whatever the rollup wrote', () => {
    const withZeroDay = [
      { ...pnlPoint('2026-07-20', '150', '-52000', '-51850'), holdingsWithKnownValue: 0 },
      ...PNL,
    ];
    expect(rebasePnlSeries(withZeroDay)[0]).toEqual({
      date: '2026-07-20',
      total: null,
      realized: null,
      unrealized: null,
    });
  });
});

describe('latestPnl', () => {
  test('skips the null tail the rollup leaves behind', () => {
    const points = [
      ...rebasePnlSeries(PNL),
      { date: '2026-08-12', total: null, realized: null, unrealized: null },
    ];
    expect(latestPnl(points)?.date).toBe('2026-08-11');
  });

  test('nothing computed is null, not zero', () => {
    expect(
      latestPnl([{ date: '2026-08-12', total: null, realized: null, unrealized: null }])
    ).toBeNull();
  });
});

describe('allocation dimensions', () => {
  // The key list is what a persisted cut is validated against (V3-48), so it
  // has to stay in step with the options the control actually renders.
  test('the key list is exactly the cuts on offer, and includes the default', () => {
    expect(ALLOCATION_DIMENSION_KEYS).toEqual(ALLOCATION_DIMENSIONS.map((cut) => cut.key));
    expect(ALLOCATION_DIMENSION_KEYS).toContain(DEFAULT_ALLOCATION_DIMENSION);
  });

  test('the four cuts fit a segmented control, which takes at most four', () => {
    expect(ALLOCATION_DIMENSIONS).toHaveLength(4);
  });
});

describe('foldedAllocationItems', () => {
  test('the tail the bar folded away is offered in full', () => {
    const items = Array.from({ length: 9 }, (_, index) => ({
      key: `k${index}`,
      label: `Item ${index}`,
      value: 100 - index,
    }));
    const shown = [{ key: 'k0' }, { key: 'k1' }, { key: '__other__' }];
    expect(foldedAllocationItems(items, shown).map((item) => item.key)).toEqual([
      'k2',
      'k3',
      'k4',
      'k5',
      'k6',
      'k7',
      'k8',
    ]);
  });

  test('nothing folded means nothing to disclose', () => {
    const items = [{ key: 'a', label: 'A', value: 1 }];
    expect(foldedAllocationItems(items, [{ key: 'a' }])).toEqual([]);
  });
});

describe('topHoldingRows', () => {
  const HOLDINGS = [
    {
      id: '11111111-1111-1111-1111-111111111111-0',
      symbol: 'BTC',
      name: 'Bitcoin',
      value: '50000',
      institutionName: 'Kraken',
      accountName: 'Spot',
    },
    {
      id: '22222222-2222-2222-2222-222222222222-1',
      symbol: 'ETH',
      name: 'Ethereum',
      value: '25000',
    },
  ];

  test('the rank suffix the API adds is stripped so the peek URL resolves', () => {
    expect(topHoldingRows(HOLDINGS, '100000').map((row) => row.holdingId)).toEqual([
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    ]);
  });

  test('share is of the portfolio, and the row keeps its own key', () => {
    const [first] = topHoldingRows(HOLDINGS, '100000');
    expect(first?.share).toBe(50);
    expect(first?.key).toBe('11111111-1111-1111-1111-111111111111-0');
    expect(first?.sublabel).toBe('Bitcoin · Kraken · Spot');
  });

  test('an unknown total is no share rather than a share of nothing', () => {
    expect(topHoldingRows(HOLDINGS, null)[0]?.share).toBeNull();
    expect(topHoldingRows(HOLDINGS, '0')[0]?.share).toBeNull();
  });

  test('a holding with no institution still reads as itself', () => {
    expect(topHoldingRows(HOLDINGS, '100000')[1]?.sublabel).toBe('Ethereum');
  });
});

describe('groupRows', () => {
  const GROUPS = [
    { id: 'g1', name: 'Retirement', color: '#ff0000', holdingsCount: 6, accountsCount: 0 },
    { id: 'g2', name: 'Rainy day', color: null, holdingsCount: 1, accountsCount: 2 },
    { id: 'g3', name: 'Empty', color: null, holdingsCount: 0, accountsCount: 0 },
  ];

  const valued = (groupId: string, value: string, holdingsCounted: number) => ({
    groupId,
    value,
    holdingsCounted,
    unpricedSymbols: [],
  });

  test('value comes from the groups aggregate, biggest first', () => {
    const rows = groupRows(GROUPS, [valued('g2', '9000', 3), valued('g1', '40000', 6)]);
    expect(rows.map((row) => [row.id, row.value])).toEqual([
      ['g1', 40000],
      ['g2', 9000],
      ['g3', null],
    ]);
  });

  test('a group the aggregate has no row for keeps its counts and no figure', () => {
    expect(groupRows(GROUPS, [])[0]?.value).toBeNull();
  });

  /**
   * An empty group really is worth zero and says so, but a group whose every
   * position is unpriceable is *unknown* — printing zero there would understate
   * it by its whole value.
   */
  test('an empty group reads zero; one we could not price reads as no figure', () => {
    const rows = groupRows(GROUPS, [
      valued('g3', '0', 0),
      { groupId: 'g1', value: '0', holdingsCounted: 0, unpricedSymbols: ['AAPL'] },
    ]);
    expect(rows.find((row) => row.id === 'g3')?.value).toBe(0);
    expect(rows.find((row) => row.id === 'g1')?.value).toBeNull();
  });

  test('counts read as words, and a group with none says so', () => {
    const rows = groupRows(GROUPS, []);
    expect(rows.map((row) => row.sublabel)).toEqual([
      '6 holdings',
      '1 holding · 2 accounts',
      'Empty',
    ]);
  });

  /**
   * `COUNT(*)` used to cross the wire as `"1"`, not `1`, and a strict
   * comparison against the number rendered "1 holdings" — the first
   * screenshot of this block showed exactly that. The coercion now lives in
   * `GroupWithCountsDto`, so the count arrives as a number and this holds the
   * sentence rather than the type (SC-88).
   */
  test('a group of one pluralises as singular and drops the empty half', () => {
    const rows = groupRows(
      [{ id: 'g', name: 'Solo', color: null, holdingsCount: 1, accountsCount: 0 }],
      []
    );
    expect(rows[0]?.sublabel).toBe('1 holding');
  });
});

describe('vaultRows', () => {
  const VAULT = {
    id: 'v1',
    name: 'House',
    color: '#00ff00',
    currencySymbol: 'EUR',
    currentAmount: '13000',
    targetAmount: '10000',
    progress: 130,
  };

  test('an over-funded vault keeps its real figure and a full track', () => {
    const [row] = vaultRows([VAULT]);
    expect(row?.progress).toBe(130);
    expect(row?.fill).toBe(100);
  });

  test('a negative or unmeasurable progress draws nothing rather than going backwards', () => {
    expect(vaultRows([{ ...VAULT, progress: -5 }])[0]?.fill).toBe(0);
    expect(vaultRows([{ ...VAULT, progress: Number.NaN }])[0]?.progress).toBe(0);
  });
});

describe('home metrics', () => {
  test('the toggle offers exactly net worth and PnL', () => {
    expect(HOME_METRICS.map((metric) => metric.key)).toEqual(['net-worth', 'pnl']);
  });

  test('the key list is exactly the metrics on offer', () => {
    expect(HOME_METRIC_KEYS).toEqual(['net-worth', 'pnl']);
  });
});

describe('period options', () => {
  test("v2's five windows are all offered", () => {
    expect(HOME_PERIODS.map((period) => period.label)).toEqual(['1W', '1M', '3M', '6M', '1Y']);
  });

  test('a month stays the default, so the screen opens where it did', () => {
    expect(DEFAULT_HOME_PERIOD.key).toBe('30d');
  });

  test('the key list is exactly the windows on offer, and includes the default', () => {
    expect(HOME_PERIOD_KEYS).toEqual(HOME_PERIODS.map((period) => period.key));
    expect(HOME_PERIOD_KEYS).toContain(DEFAULT_HOME_PERIOD.key);
  });
});

/**
 * SC-161 — the figure says how much of itself is a measurement, and what was
 * set aside to say so.
 *
 * Three axes that shipped over three tickets (SC-146 coverage, SC-149 cost
 * basis, SC-151 stale quotes), read by one summary. Every one of them biases
 * the figure upward, so a silent figure is not a neutral one, and the whole
 * point of the summary is that the bias is visible where the number is read
 * rather than in an export nobody opens.
 */
describe('summariseQuality', () => {
  const point = (over: Partial<QualityPoint>): QualityPoint => ({
    holdingsWithKnownValue: 30,
    holdingsTotal: 30,
    holdingsUnpriceable: 0,
    holdingsStalePriced: 0,
    holdingsBasisUnknown: 0,
    ...over,
  });

  test('dust nothing can price leaves the denominator rather than failing it', () => {
    // SC-146's whole fix: 28 priced out of 30 holdings is 93%, but four of
    // those thirty have no market at all, so the honest reading is 28 of 26 —
    // clamped — and never "28 of 30, you are missing two".
    const quality = summariseQuality(
      point({ holdingsWithKnownValue: 26, holdingsUnpriceable: 4 }),
      { includeBasis: false }
    );
    expect(quality?.priceable).toBe(26);
    expect(quality?.complete).toBe(true);
    expect(quality?.unpriceable).toBe(4);
  });

  test('the percentage floors, so a near-miss never reads as a full house', () => {
    const quality = summariseQuality(point({ holdingsWithKnownValue: 299, holdingsTotal: 300 }), {
      includeBasis: false,
    });
    expect(quality?.percent).toBe(99);
    expect(quality?.complete).toBe(false);
  });

  test('a day with nothing priceable in it has no answer, not a zero', () => {
    // Every holding is dust. "0% priced" would be a claim; there is none to
    // make, so the note does not render at all.
    expect(
      summariseQuality(point({ holdingsWithKnownValue: 0, holdingsUnpriceable: 30 }), {
        includeBasis: false,
      })
    ).toBeNull();
  });

  test('cost basis is carried only for the metric it qualifies', () => {
    // SC-149 is explicit that basis must not degrade the value reading. The
    // net-worth figure never mentions it; the PnL figure always does.
    const source = point({ holdingsBasisUnknown: 3 });
    expect(summariseQuality(source, { includeBasis: false })?.basisUnknown).toBe(0);
    expect(summariseQuality(source, { includeBasis: true })?.basisUnknown).toBe(3);
  });
});

describe('qualityHeadline', () => {
  test('answers the question in the form it was asked — a percentage', () => {
    const quality = summariseQuality(
      {
        holdingsWithKnownValue: 28,
        holdingsTotal: 34,
        holdingsUnpriceable: 4,
        holdingsStalePriced: 0,
        holdingsBasisUnknown: 0,
      },
      { includeBasis: false }
    );
    expect(quality).not.toBeNull();
    const text = qualityHeadline(quality as FigureQuality);
    expect(text).toContain('93%');
    // And the counts behind it, because 28 of 30 is checkable against the
    // holdings list and 93% is not.
    expect(text).toContain('28 of 30 holdings');
  });

  /**
   * SC-176 — the unpriceable count sits with the denominator it explains.
   *
   * As a clause in the omissions run a line below, "2 unpriceable" read as a
   * correction of "All 12 holdings priced": both are true — 14 holdings, 2 of
   * them quotable by nobody, all 12 that are quotable priced — but the reader
   * had to rebuild the total to see it. Beside the fraction, it is arithmetic.
   */
  test('the unpriceable count rides with the fraction it defines', () => {
    const quality = summariseQuality(
      {
        holdingsWithKnownValue: 12,
        holdingsTotal: 14,
        holdingsUnpriceable: 2,
        holdingsStalePriced: 0,
        holdingsBasisUnknown: 0,
      },
      { includeBasis: false }
    );
    expect(qualityHeadline(quality as FigureQuality)).toBe(
      'All 12 holdings priced · 2 unpriceable'
    );
    // …and it is not also said below, which would be the same fact twice.
    expect(qualityOmissions(quality as FigureQuality)).toEqual([]);
  });

  test('a full house is stated as one rather than as 100%', () => {
    const quality = summariseQuality(
      {
        holdingsWithKnownValue: 12,
        holdingsTotal: 12,
        holdingsUnpriceable: 0,
        holdingsStalePriced: 0,
        holdingsBasisUnknown: 0,
      },
      { includeBasis: false }
    );
    expect(qualityHeadline(quality as FigureQuality)).toBe('All 12 holdings priced');
  });
});

describe('qualityOmissions', () => {
  const quality = (over: Partial<FigureQuality>): FigureQuality => ({
    priced: 30,
    priceable: 30,
    percent: 100,
    complete: true,
    unpriceable: 0,
    stalePriced: 0,
    basisUnknown: 0,
    transfersUnreviewed: 0,
    ...over,
  });

  test('an account with nothing to report gets no list', () => {
    expect(qualityOmissions(quality({}))).toEqual([]);
  });

  test('"unpriceable", never "unpriced" — we did not fail to fetch a price', () => {
    // The word survives; only its home moved (SC-176). It is the headline's
    // now, because it is the only one of the four about the denominator.
    expect(qualityHeadline(quality({ unpriceable: 4 }))).toContain('4 unpriceable');
    expect(qualityOmissions(quality({ unpriceable: 4 }))).toEqual([]);
  });

  test('a stale quote is its own axis, not a worse grade of coverage', () => {
    // 100% priced and still built on old numbers — the case that makes this a
    // separate clause rather than a lower percentage (SC-151).
    expect(qualityOmissions(quality({ stalePriced: 2 }))).toEqual(['2 stale quotes']);
    expect(qualityOmissions(quality({ stalePriced: 1 }))).toEqual(['1 stale quote']);
  });

  test('an unknown cost basis says which way the gain errs', () => {
    // SC-176 cut this run hard to get the note under three lines at 390px, and
    // this is the clause that was NOT allowed to lose its tail: a count tells a
    // reader how much is uncertain, and only these four words tell them which
    // direction the figure is wrong in.
    expect(qualityOmissions(quality({ basisUnknown: 3 }))[0]).toContain('upper bound');
  });

  test('both at once are two facts, in the order they were asked', () => {
    expect(qualityOmissions(quality({ stalePriced: 2, basisUnknown: 3 }))).toEqual([
      '2 stale quotes',
      '3 no cost basis (gain is an upper bound)',
    ]);
  });

  /**
   * SC-176 — the note is a caption, and a caption taller than its figure is
   * not a caption.
   *
   * At 390px the caption is 13px in a 327px content box; the three lines the
   * worst case (the PnL tab, all four counts live) must come in at were each
   * measured in a real 390px browser, and the longest that fitted was 57
   * characters. A character count is a crude proxy for a width — 56 characters
   * of wide glyphs wrapped where 56 narrow ones did not — so this is a ceiling
   * against drift, not a layout check. The layout check is a phone.
   */
  test('the worst case still fits three lines at 390px', () => {
    const worst = quality({
      priced: 12,
      priceable: 12,
      complete: true,
      unpriceable: 2,
      stalePriced: 2,
      basisUnknown: 5,
      transfersUnreviewed: 3,
    });
    const lines = [
      qualityHeadline(worst),
      qualityOmissions(worst).join(' · '),
      unreviewedTransfersNote(worst) ?? '',
    ];
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(57);
  });
});

/**
 * SC-160 — the clause that runs the other way, and the only one with somewhere
 * to go.
 *
 * `qualityOmissions` says the figure may be too HIGH: dust left out, an old
 * quote, a cost basis we could not fully rebuild. This one says realized PnL
 * is too LOW, because SC-150 refuses to realize an exit nobody has answered.
 * It is a separate function for exactly that reason — folded into the run, a
 * reader who has learned "these all flatter the number" reads it backwards —
 * and because the caller renders it as a link, which a string cannot carry.
 */
describe('unreviewedTransfersNote', () => {
  const quality = (over: Partial<FigureQuality>): FigureQuality => ({
    priced: 30,
    priceable: 30,
    percent: 100,
    complete: true,
    unpriceable: 0,
    stalePriced: 0,
    basisUnknown: 0,
    transfersUnreviewed: 0,
    ...over,
  });

  test('an empty queue says nothing', () => {
    expect(unreviewedTransfersNote(quality({}))).toBeNull();
  });

  test('states the exclusion as a fact, because it is one', () => {
    // "excludes", not "may exclude". The exclusion is certain; only whether
    // each excluded row was a sale is not, and hedging the part we know to
    // avoid asserting the part we do not makes the sentence false the other
    // way.
    const line = unreviewedTransfersNote(quality({ transfersUnreviewed: 3 }));
    expect(line).toBe('Realized PnL excludes 3 unconfirmed transfers');
  });

  test('one transfer is a transfer', () => {
    expect(unreviewedTransfersNote(quality({ transfersUnreviewed: 1 }))).toBe(
      'Realized PnL excludes 1 unconfirmed transfer'
    );
  });

  /**
   * SC-176 — the sentence IS the tap target, so its wrapping is a link defect
   * and not only a typography one.
   *
   * "3 transfers you have not confirmed" wrapped at 390px and the underline ran
   * across two lines with "confirmed" alone on the second, which reads as two
   * links. Same claim, one line.
   */
  test('it fits one 390px line, because the whole sentence is the link', () => {
    expect(
      (unreviewedTransfersNote(quality({ transfersUnreviewed: 999 })) ?? '').length
    ).toBeLessThanOrEqual(56);
  });

  test('it never joins the omissions run', () => {
    // The two lists are rendered as different things — prose and a link — so a
    // count leaking into the other one would be both a wrong sentence and an
    // unreachable tap target.
    expect(qualityOmissions(quality({ transfersUnreviewed: 3 }))).toEqual([]);
  });

  test('it is carried only for the metric it qualifies', () => {
    // Same gate as cost basis (SC-149): an unanswered withdrawal says nothing
    // about what the portfolio is worth today, only about what it realized on
    // the way here.
    const source: QualityPoint = {
      holdingsWithKnownValue: 30,
      holdingsTotal: 30,
      holdingsUnpriceable: 0,
      holdingsStalePriced: 0,
      holdingsBasisUnknown: 0,
      transfersUnreviewed: 4,
    };
    expect(summariseQuality(source, { includeBasis: false })?.transfersUnreviewed).toBe(0);
    expect(summariseQuality(source, { includeBasis: true })?.transfersUnreviewed).toBe(4);
  });

  /**
   * The net-worth series does not carry the field at all — `NetWorthHistoryRow`
   * omits it deliberately — so `QualityPoint` declares it optional. That is
   * accurate, and it is also the shape that can go quiet: a wiring break reads
   * as "nothing to report" rather than as a failure. Pinned here.
   */
  test('a point without the field reads as an empty queue, not as a crash', () => {
    const netWorthPoint: QualityPoint = {
      holdingsWithKnownValue: 30,
      holdingsTotal: 30,
      holdingsUnpriceable: 0,
      holdingsStalePriced: 0,
      holdingsBasisUnknown: 0,
    };
    const q = summariseQuality(netWorthPoint, { includeBasis: true });
    expect(q?.transfersUnreviewed).toBe(0);
    expect(unreviewedTransfersNote(q as FigureQuality)).toBeNull();
  });
});

describe('latestMeasured', () => {
  test('is the last day the series actually priced something', () => {
    expect(latestMeasured(SERIES)?.date).toBe(SERIES[SERIES.length - 1]?.date);
  });

  test('skips a tail of days nothing was priced on', () => {
    // A scoped series still carries its uncovered days, and taking its last
    // row would qualify the headline with a day that measured nothing.
    const series = [...SERIES, uncovered('2026-08-12')];
    expect(latestMeasured(series)?.date).not.toBe('2026-08-12');
  });

  test('an empty series has no day to describe', () => {
    expect(latestMeasured([])).toBeNull();
  });
});

describe('latestPnlSource', () => {
  test('reads the day the headline states, not the last row', () => {
    // The rollup fills value before it fills PnL, so the tail is routinely
    // null. Qualifying a different day than the one on screen would be its
    // own quiet lie.
    const series = [
      { ...pnlPoint('2026-08-10', '150', '250', '400'), holdingsBasisUnknown: 2 },
      pnlPoint('2026-08-11', null, null, null),
    ];
    expect(latestPnlSource(series)?.date).toBe('2026-08-10');
    expect(summariseQuality(latestPnlSource(series), { includeBasis: true })?.basisUnknown).toBe(2);
  });
});
