import { describe, expect, test } from 'bun:test';
import type { IncludedHoldingScopeRow } from '@scani/domain/repositories';
import { aggregateIncludedHoldingRows, toNetWorthHistoryRow } from '../../src/lib/net-worth-series';

/**
 * SC-249 at the boundary. `BalanceAtTimeService` computed anchor provenance
 * and `PortfolioValuationAtTimeService` carried it, and it stopped one layer
 * short of anyone who could act on it — every chart endpoint is a pure cache
 * read of `portfolio_value_daily`, so provenance that never reached the wire
 * never reached anybody.
 *
 * These assert the two mappers that ARE the wire. A test on the service alone
 * would have gone green for years on this defect, because the service was
 * never the part that was wrong.
 *
 * The NULL-propagation cases matter most. `holdings_stale_anchored` is
 * nullable precisely so a row written before the column can say "not
 * recorded" instead of "none" — the mistake `holdings_stale_priced` made by
 * taking `NOT NULL DEFAULT 0` in migration 0031, which left every pre-SC-151
 * row asserting a confident zero.
 */

const DAYS_BACK = new Date('2026-06-05T12:00:00Z');
const SECONDS_BACK = new Date('2026-08-15T11:59:06Z');

function row(over: Partial<IncludedHoldingScopeRow> = {}): IncludedHoldingScopeRow {
  return {
    snapshotDate: '2026-08-15',
    holdingId: 'h1',
    totalValue: '100',
    costBasis: '50',
    realizedPnl: '0',
    unrealizedPnl: '50',
    coverageQuality: 'full',
    holdingsWithKnownValue: 1,
    holdingsTotal: 1,
    holdingsUnpriceable: 0,
    holdingsStalePriced: 0,
    holdingsStaleAnchored: 0,
    oldestAnchorAt: null,
    holdingsBeforeRecords: 0,
    holdingsBasisUnknown: 0,
    transfersUnreviewed: 0,
    ...over,
  };
}

describe('anchor provenance survives to the wire', () => {
  test('the day reports the OLDEST anchor across its holdings', () => {
    const [day] = aggregateIncludedHoldingRows([
      row({ holdingId: 'h-recent', holdingsStaleAnchored: 1, oldestAnchorAt: SECONDS_BACK }),
      row({ holdingId: 'h-old', holdingsStaleAnchored: 1, oldestAnchorAt: DAYS_BACK }),
    ]);

    expect(day?.holdingsStaleAnchored).toBe(2);
    expect(day?.oldestAnchorAt).toBe(DAYS_BACK.toISOString());
  });

  test('one unrecorded holding makes the whole day unrecorded, not an undercount', () => {
    // Summing the rows that DO carry a count would report a confident number
    // that is too low — worse than admitting the day cannot be counted,
    // because a reader cannot tell a real 1 from a 1-of-unknown.
    const [day] = aggregateIncludedHoldingRows([
      row({ holdingId: 'h-known', holdingsStaleAnchored: 1, oldestAnchorAt: DAYS_BACK }),
      row({ holdingId: 'h-legacy', holdingsStaleAnchored: null }),
    ]);

    expect(day?.holdingsStaleAnchored).toBeNull();
  });

  test('a day where every holding counted and none was backward-anchored reports 0', () => {
    const [day] = aggregateIncludedHoldingRows([row(), row({ holdingId: 'h2' })]);

    expect(day?.holdingsStaleAnchored).toBe(0);
    expect(day?.oldestAnchorAt).toBeNull();
    expect(day?.coverageQuality).toBe('full');
  });

  test('a backward anchor degrades the day even when every price is fresh', () => {
    // The rollup writes 'partial' on such a row, but this aggregator
    // re-derives coverage from the per-holding rows and used to look only at
    // `holdingsStalePriced`. A row whose quantity is a projection and whose
    // prices are all current would have read 'full' here.
    const [day] = aggregateIncludedHoldingRows([
      row({
        coverageQuality: 'full',
        holdingsStalePriced: 0,
        holdingsStaleAnchored: 1,
        oldestAnchorAt: DAYS_BACK,
      }),
    ]);

    expect(day?.coverageQuality).toBe('partial');
  });

  test('both columns reach the exported row', () => {
    // `NetWorthHistoryRow` is what the home-chart CSV and the account
    // workbook both write. A spreadsheet the reader lays beside the chart is
    // the surface where an unqualified figure does the most damage, because
    // it outlives the screen it came from.
    const [day] = aggregateIncludedHoldingRows([
      row({ holdingsStaleAnchored: 1, oldestAnchorAt: DAYS_BACK }),
    ]);
    const exported = toNetWorthHistoryRow(day!);

    expect(exported.holdingsStaleAnchored).toBe(1);
    expect(exported.oldestAnchorAt).toBe(DAYS_BACK.toISOString());
  });

  test('an unrecorded day exports null rather than zero', () => {
    const [day] = aggregateIncludedHoldingRows([row({ holdingsStaleAnchored: null })]);
    const exported = toNetWorthHistoryRow(day!);

    expect(exported.holdingsStaleAnchored).toBeNull();
  });
});

/**
 * SC-317, and the same three properties one column to the right. A day before
 * a holding's first evidence has been 'partial' since SC-252 and said so with
 * every count at zero — the grade without the cause.
 *
 * The pair is the point. `holdings_stale_anchored` means projected FORWARD
 * from a stale observation, this means projected BACKWARD past anything that
 * records the holding, and the remedies differ. A reader who can see one and
 * not the other attributes the downgrade to whichever cause is visible.
 */
describe('pre-evidence provenance survives to the wire', () => {
  test('the day sums the counts across its holdings', () => {
    const [day] = aggregateIncludedHoldingRows([
      row({ holdingId: 'h-a', holdingsBeforeRecords: 1 }),
      row({ holdingId: 'h-b', holdingsBeforeRecords: 1 }),
    ]);

    expect(day?.holdingsBeforeRecords).toBe(2);
  });

  test('one unrecorded holding makes the whole day unrecorded, not an undercount', () => {
    const [day] = aggregateIncludedHoldingRows([
      row({ holdingId: 'h-known', holdingsBeforeRecords: 1 }),
      row({ holdingId: 'h-legacy', holdingsBeforeRecords: null }),
    ]);

    expect(day?.holdingsBeforeRecords).toBeNull();
    // The sibling was recorded on both rows, so it stays a number. Null
    // propagation is per column: one legacy column does not erase another.
    expect(day?.holdingsStaleAnchored).toBe(0);
  });

  test('a pre-evidence day degrades even when prices are fresh and nothing was anchored', () => {
    // The exact row SC-317 was filed about: 'partial' with both existing
    // counts at zero. Without this column the aggregator re-derives the day
    // from per-holding rows whose own quality columns all read clean.
    const [day] = aggregateIncludedHoldingRows([
      row({
        coverageQuality: 'full',
        holdingsStalePriced: 0,
        holdingsStaleAnchored: 0,
        holdingsBeforeRecords: 1,
      }),
    ]);

    expect(day?.coverageQuality).toBe('partial');
    expect(day?.holdingsBeforeRecords).toBe(1);
  });

  test('the count reaches the exported row, and null stays null', () => {
    const [counted] = aggregateIncludedHoldingRows([row({ holdingsBeforeRecords: 2 })]);
    expect(toNetWorthHistoryRow(counted!).holdingsBeforeRecords).toBe(2);

    const [legacy] = aggregateIncludedHoldingRows([row({ holdingsBeforeRecords: null })]);
    expect(toNetWorthHistoryRow(legacy!).holdingsBeforeRecords).toBeNull();
  });
});
