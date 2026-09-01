import { afterEach, describe, expect, test } from 'bun:test';
import { PortfolioValueDailyRepository } from '@scani/domain/repositories';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import {
  aggregateIncludedHoldingRows,
  hasKnownCoverage,
  toNetWorthHistoryRow,
  unmeasuredDates,
  userNetWorthDaily,
} from '../../src/lib/net-worth-series';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * SC-98 — the two net-worth exports must not be able to disagree again.
 *
 * The defect was not a wrong number, it was **two sources**: the home chart's
 * export summed the inclusion-filtered per-holding rollup rows while the
 * whole-account workbook read the pre-aggregated `scope_kind = 'user'` row, so
 * the user held two files from the same minute stating different net worths for
 * the same date.
 *
 * The invariant under test is therefore *which table answers the question*, not
 * any particular figure — the reported values (50, 100, holdings_total = 1) were
 * contaminated dev rows and chasing them would have tested nothing. So the
 * fixture seeds a **deliberate disagreement** between the two tables and asserts
 * the answer comes from the per-holding rows, which are the ones that apply the
 * inclusion contract and therefore reconcile with the dashboard headline.
 */

const BASE = 'eur-token-id';
const USER = 'user-1';
const FROM = new Date('2026-08-01T00:00:00.000Z');
const TO = new Date('2026-08-14T23:59:59.000Z');

function seedRepository(overrides: {
  perHolding: Array<Record<string, unknown>>;
  /** What the pre-aggregated `scope_kind='user'` row says — deliberately
   *  different, and deliberately never read. */
  userScope?: Array<Record<string, unknown>>;
}) {
  const calls = { included: 0, range: 0 };
  Container.set(PortfolioValueDailyRepository, {
    findIncludedHoldingScopeRange: async () => {
      calls.included += 1;
      return overrides.perHolding;
    },
    findRange: async () => {
      calls.range += 1;
      return overrides.userScope ?? [];
    },
  } as unknown as PortfolioValueDailyRepository);
  return calls;
}

function perHoldingRow(date: string, holdingId: string, totalValue: string, known = 1) {
  return {
    snapshotDate: date,
    holdingId,
    totalValue,
    costBasis: null,
    realizedPnl: null,
    unrealizedPnl: null,
    coverageQuality: 'full',
    holdingsWithKnownValue: known,
    holdingsTotal: 1,
    holdingsUnpriceable: 0,
    holdingsStalePriced: 0,
    holdingsBasisUnknown: 0,
    transfersUnreviewed: 0,
  };
}

// One `scope_kind='holding'` row for a token nothing can price: present,
// never valued, and out of the coverage denominator (SC-146).
function unpriceableRow(date: string, holdingId: string) {
  return {
    ...perHoldingRow(date, holdingId, '0', 0),
    coverageQuality: 'unknown',
    holdingsUnpriceable: 1,
  };
}

/**
 * Put the real repository back, don't `Container.remove` it.
 *
 * `remove` wipes the `@Service()` registration, and leaving the stub in place
 * leaks it into every later suite in the same `bun test` process — both were
 * tried, and the second failed ten `PortfolioValueDailyRepository` /
 * `RollupPortfolioValueDailyUseCase` tests with `repo().upsert is not a
 * function`, the exact symptom CLAUDE.md describes for broken DI. Restoring the
 * instance is the only teardown that leaves the container as it was found.
 */
const realRepository = Container.get(PortfolioValueDailyRepository);

afterEach(() => {
  Container.set(PortfolioValueDailyRepository, realRepository);
});

describe('userNetWorthDaily', () => {
  test('answers from the per-holding rows, never the pre-aggregated user row', async () => {
    const calls = seedRepository({
      perHolding: [
        perHoldingRow('2026-08-14', 'h1', '387594.00'),
        perHoldingRow('2026-08-13', 'h1', '380000.00'),
      ],
      // The table the account workbook used to read. If this value ever comes
      // back out of the function, the two exports can disagree again.
      userScope: [{ snapshotDate: '2026-08-14', totalValue: '50', coverageQuality: 'full' }],
    });

    const series = await userNetWorthDaily(USER, BASE, FROM, TO);

    expect(series.map((row) => row.totalValue)).toEqual(['380000', '387594']);
    expect(calls.included).toBe(1);
    expect(calls.range).toBe(0);
  });

  test('sums every holding on a date into one point', async () => {
    seedRepository({
      perHolding: [
        perHoldingRow('2026-08-14', 'h1', '300000.00'),
        perHoldingRow('2026-08-14', 'h2', '87594.00'),
      ],
    });
    const series = await userNetWorthDaily(USER, BASE, FROM, TO);
    expect(series).toHaveLength(1);
    expect(series[0]?.totalValue).toBe('387594');
    expect(series[0]?.holdingsWithKnownValue).toBe(2);
  });

  test('returns dates ascending, so both exports read the same direction', async () => {
    seedRepository({
      perHolding: [
        perHoldingRow('2026-08-14', 'h1', '3'),
        perHoldingRow('2026-08-12', 'h1', '1'),
        perHoldingRow('2026-08-13', 'h1', '2'),
      ],
    });
    const series = await userNetWorthDaily(USER, BASE, FROM, TO);
    expect(series.map((row) => row.snapshotDate)).toEqual([
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
    ]);
  });

  test('omits days nothing was priced on rather than calling them zero (SC-95)', async () => {
    // The exact rows the reported CSV ended with: `2026-08-14,0,unknown,0,0`.
    // A spreadsheet sums and averages what it is given, and it cannot tell that
    // zero apart from a real one.
    seedRepository({
      perHolding: [
        perHoldingRow('2026-08-10', 'h1', '387594.00'),
        perHoldingRow('2026-08-11', 'h1', '0', 0),
        perHoldingRow('2026-08-12', 'h1', '0', 0),
      ],
    });
    const series = await userNetWorthDaily(USER, BASE, FROM, TO);
    expect(series.map((row) => row.snapshotDate)).toEqual(['2026-08-10']);
  });

  test('keeps a day whose holdings were priced and genuinely worth nothing', async () => {
    // The distinction SC-66 drew: a real zero survives, an unmeasured one does
    // not. Dropping both would be a different lie.
    seedRepository({ perHolding: [perHoldingRow('2026-08-10', 'h1', '0', 1)] });
    const series = await userNetWorthDaily(USER, BASE, FROM, TO);
    expect(series).toHaveLength(1);
    expect(series[0]?.totalValue).toBe('0');
  });
});

describe('hasKnownCoverage', () => {
  test('matches the frontend guard it mirrors', () => {
    expect(hasKnownCoverage({ holdingsWithKnownValue: 0 })).toBe(false);
    expect(hasKnownCoverage({ holdingsWithKnownValue: 1 })).toBe(true);
  });
});

/**
 * **The deliverable of SC-98**: the two files a reader can hold at once must
 * state the same net worth for the same date.
 *
 * The window each path asks for differs — the home chart exports the range on
 * screen, the workbook takes six years — so the assertion is per-date over the
 * dates they share, which is exactly the comparison the reporter made by hand
 * with two files open.
 */
describe('the two export paths agree', () => {
  // The home chart's export: `portfolio.getNetWorthSeries` with no scope and
  // `resolution: 'full'`, which skips LTTB and ships every daily row.
  async function homeChartExport(from: Date, to: Date) {
    return (await userNetWorthDaily(USER, BASE, from, to)).map(toNetWorthHistoryRow);
  }

  // The account workbook's "Net worth history" sheet: `exports.everything`.
  async function accountWorkbookExport(from: Date, to: Date) {
    return (await userNetWorthDaily(USER, BASE, from, to)).map(toNetWorthHistoryRow);
  }

  test('same figure for the same date, even when the pre-aggregated row disagrees', async () => {
    seedRepository({
      perHolding: [
        perHoldingRow('2026-08-14', 'h1', '300000.00'),
        perHoldingRow('2026-08-14', 'h2', '87594.00'),
        perHoldingRow('2026-08-13', 'h1', '380000.00'),
        perHoldingRow('2026-08-12', 'h1', '0', 0),
      ],
      // What the workbook used to read, and what made the two files disagree.
      userScope: [
        { snapshotDate: '2026-08-14', totalValue: '50', coverageQuality: 'full' },
        { snapshotDate: '2026-08-13', totalValue: '50', coverageQuality: 'full' },
      ],
    });

    // Deliberately different windows: the chart is on 1M, the workbook takes
    // everything. Agreement has to survive that, because that is how they are
    // actually produced.
    const chart = await homeChartExport(new Date('2026-07-15T00:00:00.000Z'), TO);
    const workbook = await accountWorkbookExport(FROM, TO);

    const workbookByDate = new Map(workbook.map((row) => [row.date, row]));
    expect(chart.length).toBeGreaterThan(0);
    for (const row of chart) {
      expect(`${row.date}=${workbookByDate.get(row.date)?.totalValue}`).toBe(
        `${row.date}=${row.totalValue}`
      );
    }
    // And the same columns, not just the same numbers under different names.
    expect(Object.keys(chart[0] ?? {}).sort()).toEqual(Object.keys(workbook[0] ?? {}).sort());
    // The figure both now report for 2026-08-14 — the date that had three
    // different answers in QA round 3.
    expect(workbookByDate.get('2026-08-14')?.totalValue).toBe('387594');
  });
});

describe('no caller reads the user-scope row for user-wide history', () => {
  test('neither router selects portfolioValueDaily directly', async () => {
    // The structural half of the fix. Unifying the two call sites is only
    // durable if a third cannot be written the old way, and the old way looked
    // exactly like a reasonable drizzle select — which is how it got written.
    for (const file of ['exports.ts', 'portfolio.ts']) {
      const code = await Bun.file(
        `${import.meta.dir}/../../src/presentation/routers/${file}`
      ).text();
      const usesUserScope =
        code.includes('portfolioValueDaily') && code.includes("scopeKind, 'user'");
      expect(`${file}:${usesUserScope}`).toBe(`${file}:false`);
      // Both must reach user-wide history through the one function; a second
      // source is what SC-98 was.
      expect(`${file}:${code.includes('userNetWorthDaily')}`).toBe(`${file}:true`);
    }
  });
});

/**
 * SC-115 — the days the filter removes have to be reportable, or the chart
 * draws a straight line through them and calls it a measurement.
 */
describe('unmeasuredDates', () => {
  test('names every day between the measurements and the end of the window', () => {
    expect(unmeasuredDates(['2026-08-10', '2026-08-12'], '2026-08-14')).toEqual([
      '2026-08-11',
      '2026-08-13',
      '2026-08-14',
    ]);
  });

  test('says nothing when every day was measured', () => {
    expect(unmeasuredDates(['2026-08-13', '2026-08-14'], '2026-08-14')).toEqual([]);
  });

  /**
   * History that predates the account is not a gap in what we know. Reporting
   * it would compress a year of real data into the right-hand corner of a
   * chart whose left half never had an answer to give.
   */
  test('does not report the window before the first measurement', () => {
    expect(unmeasuredDates(['2026-08-13'], '2026-08-14')).toEqual(['2026-08-14']);
  });

  test('an account with no measurements at all reports no gaps', () => {
    expect(unmeasuredDates([], '2026-08-14')).toEqual([]);
  });

  test('crosses a month boundary rather than counting past 31', () => {
    expect(unmeasuredDates(['2026-07-30'], '2026-08-02')).toEqual([
      '2026-07-31',
      '2026-08-01',
      '2026-08-02',
    ]);
  });
});

describe('aggregateIncludedHoldingRows — unpriceable holdings (SC-146)', () => {
  test('dust leaves the denominator, so a fully-priced day reads as full', async () => {
    // The production shape: several assets priced, a couple of airdrop tokens
    // that no provider indexes. Before the fix this day counted the airdrops in
    // the denominator and rendered a coverage figure well under 100% on a
    // portfolio where everything the user owns was priced.
    seedRepository({
      perHolding: [
        perHoldingRow('2026-08-14', 'h-btc', '60000'),
        perHoldingRow('2026-08-14', 'h-eth', '3000'),
        perHoldingRow('2026-08-14', 'h-aapl', '200'),
        perHoldingRow('2026-08-14', 'h-usdt', '10'),
        unpriceableRow('2026-08-14', 'h-spam1'),
        unpriceableRow('2026-08-14', 'h-spam2'),
      ],
    });

    const series = await userNetWorthDaily(USER, BASE, FROM, TO);

    expect(series).toHaveLength(1);
    expect(series[0]?.holdingsTotal).toBe(6);
    expect(series[0]?.holdingsUnpriceable).toBe(2);
    expect(series[0]?.holdingsWithKnownValue).toBe(4);
    expect(series[0]?.coverageQuality).toBe('full');
    expect(series[0]?.totalValue).toBe('63210');
  });

  test('a genuinely unpriced holding still degrades the day', async () => {
    seedRepository({
      perHolding: [
        perHoldingRow('2026-08-14', 'h-btc', '60000'),
        perHoldingRow('2026-08-14', 'h-eth', '3000'),
        perHoldingRow('2026-08-14', 'h-gap', '0', 0), // priceable, no quote today
        unpriceableRow('2026-08-14', 'h-spam1'),
      ],
    });

    const series = await userNetWorthDaily(USER, BASE, FROM, TO);

    expect(series[0]?.holdingsWithKnownValue).toBe(2);
    expect(series[0]?.holdingsUnpriceable).toBe(1);
    expect(series[0]?.coverageQuality).toBe('estimated'); // 2 of 3 priceable
  });

  test('a day of nothing but dust is omitted, not reported as zero', async () => {
    seedRepository({
      perHolding: [
        perHoldingRow('2026-08-13', 'h-btc', '60000'),
        unpriceableRow('2026-08-14', 'h-spam1'),
        unpriceableRow('2026-08-14', 'h-spam2'),
      ],
    });

    const series = await userNetWorthDaily(USER, BASE, FROM, TO);

    expect(series.map((row) => row.snapshotDate)).toEqual(['2026-08-13']);
  });

  test('the exported row carries the exclusion so a file can explain itself', async () => {
    seedRepository({
      perHolding: [
        perHoldingRow('2026-08-14', 'h-btc', '60000'),
        unpriceableRow('2026-08-14', 'h-spam1'),
      ],
    });

    const series = await userNetWorthDaily(USER, BASE, FROM, TO);
    const row = toNetWorthHistoryRow(series[0]!);

    expect(row.holdingsTotal).toBe(2);
    expect(row.holdingsUnpriceable).toBe(1);
    expect(row.holdingsWithKnownValue).toBe(1);
  });
});

/**
 * SC-151 / SC-149 — the two quality counts survive aggregation and reach the file.
 *
 * The first test here is the one that mattered: `aggregateIncludedHoldingRows`
 * has always had an `anyPartial` branch, and no writer had ever produced a
 * per-holding row saying `'partial'` — the rollup's `upsertScopeRow` computed
 * the stale flag and dropped it. So the branch was unreachable, and every
 * stale price arrived at the chart and both exports looking like a quote taken
 * that morning.
 */
describe('aggregateIncludedHoldingRows — quality counts (SC-151, SC-149)', () => {
  test('a stale-priced holding downgrades an otherwise fully-priced day', async () => {
    const fresh = perHoldingRow('2026-08-01', 'h1', '1000');
    const stale = { ...perHoldingRow('2026-08-01', 'h2', '500'), holdingsStalePriced: 1 };
    const series = aggregateIncludedHoldingRows([fresh, stale] as never);

    // 100% priced, and still not 'full': half the figure is old.
    expect(series[0]?.coverageQuality).toBe('partial');
    expect(series[0]?.holdingsStalePriced).toBe(1);
    expect(series[0]?.totalValue).toBe('1500');
  });

  test('a day priced entirely from fresh quotes stays full', async () => {
    const series = aggregateIncludedHoldingRows([
      perHoldingRow('2026-08-01', 'h1', '1000'),
      perHoldingRow('2026-08-01', 'h2', '500'),
    ] as never);
    expect(series[0]?.coverageQuality).toBe('full');
    expect(series[0]?.holdingsStalePriced).toBe(0);
  });

  test('basis-unknown counts sum across holdings and reach the export row', async () => {
    const truncated = { ...perHoldingRow('2026-08-01', 'h1', '1000'), holdingsBasisUnknown: 1 };
    const complete = perHoldingRow('2026-08-01', 'h2', '500');
    const series = aggregateIncludedHoldingRows([truncated, complete] as never);
    expect(series[0]?.holdingsBasisUnknown).toBe(1);

    // The file is the artifact people forward, so the count has to be in it —
    // whoever opens it next has no chart and no session, only these columns.
    const row = toNetWorthHistoryRow(series[0]!);
    expect(row.holdingsBasisUnknown).toBe(1);
    expect(row.holdingsStalePriced).toBe(0);
  });

  /**
   * SC-160. The count that runs the other way — realized PnL is SHORT by
   * whatever the genuine off-platform sales among these rows were worth,
   * because SC-150 refuses to realize an exit nobody has answered.
   *
   * Additive across holdings for the same reason every other count here is: a
   * transaction belongs to exactly one holding, so the per-holding rows the
   * home chart is built from sum to the user-wide figure.
   *
   * And deliberately absent from the export row. It qualifies realized PnL,
   * and neither file `NetWorthHistoryRow` writes carries a PnL column — a
   * count explaining a figure that is not in the file is one a reader can only
   * misread. The assertion below is what keeps that a decision rather than an
   * omission somebody quietly reverses.
   */
  test('unreviewed-transfer counts sum, and stay off the net-worth export row', async () => {
    const withExits = { ...perHoldingRow('2026-08-01', 'h1', '1000'), transfersUnreviewed: 2 };
    const other = { ...perHoldingRow('2026-08-01', 'h2', '500'), transfersUnreviewed: 1 };
    const series = aggregateIncludedHoldingRows([withExits, other] as never);
    expect(series[0]?.transfersUnreviewed).toBe(3);

    const row = toNetWorthHistoryRow(series[0]!);
    expect('transfersUnreviewed' in row).toBe(false);
  });

  test('rows written before the migration behave exactly as they did', async () => {
    // DEFAULT 0 on both columns: a pre-rebuild row says nothing new and is
    // graded by coverage_quality alone, which is what it has always carried.
    const legacy = { ...perHoldingRow('2026-08-01', 'h1', '1000'), coverageQuality: 'partial' };
    const series = aggregateIncludedHoldingRows([legacy] as never);
    expect(series[0]?.coverageQuality).toBe('partial');
    expect(series[0]?.holdingsStalePriced).toBe(0);
  });
});
