import { describe, expect, test } from 'bun:test';
import { PortfolioValueDailyRepository } from '@scani/domain/repositories';
import {
  makeAccount,
  makeHolding,
  makeInstitution,
  makeToken,
  makeUser,
  withTestDb,
} from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { aggregateDailyTotals } from '../../src/lib/net-worth-series';
import { legacyAggregateIncludedHoldingRows } from './helpers/day-totals';

/**
 * SC-1369: the net-worth series stopped summing every holding's row in JS and
 * asks SQL for one row per day. The output must not move by a character, so
 * this runs both paths over the same real rows: the SQL day totals through
 * `aggregateDailyTotals`, against the JS summation as it stood on main before
 * the change (`legacyAggregateIncludedHoldingRows`, copied verbatim).
 *
 * The fixture is built to reach every branch that summation had: a day whose
 * PnL is incomplete, a day with a pre-provenance NULL count, a partial row, a
 * stale price, an unpriceable holding, two different anchor instants, money
 * with more decimals than a float keeps, and rows the inclusion contract must
 * drop (a hidden holding, an inactive one, another base currency, the
 * user-scope row).
 */

const repo = () => Container.get(PortfolioValueDailyRepository);
const FROM = new Date('2026-03-01T00:00:00.000Z');
const TO = new Date('2026-03-31T23:59:59.000Z');

type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];

async function row(
  tx: Tx,
  userId: string,
  scopeId: string,
  baseCurrencyId: string,
  snapshotDate: string,
  over: Record<string, unknown> = {}
) {
  await repo().upsert(
    {
      userId,
      snapshotDate,
      baseCurrencyId,
      totalValue: '100',
      costBasis: '80',
      realizedPnl: '5',
      unrealizedPnl: '20',
      coverageQuality: 'full',
      holdingsWithKnownValue: 1,
      holdingsTotal: 1,
      holdingsUnpriceable: 0,
      holdingsStalePriced: 0,
      holdingsStaleAnchored: 0,
      holdingsBeforeRecords: 0,
      holdingsBasisUnknown: 0,
      transfersUnreviewed: 0,
      scopeKind: 'holding' as const,
      scopeId,
      ...over,
    } as never,
    tx
  );
}

describe('net-worth day totals: SQL sums equal the old JS summation (SC-1369)', () => {
  test('every branch of the old aggregation, over real rows', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const base = await makeToken(tx);
      const other = await makeToken(tx);
      const inst = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const h = (over = {}) =>
        makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: base.id, ...over });
      const [a, b, c, d] = [await h(), await h(), await h(), await h()];
      const hidden = await h({ isHidden: true });
      const inactive = await h({ isActive: false });

      // Day 1: plain, with more decimals than a double keeps.
      await row(tx, user.id, a.id, base.id, '2026-03-02', { totalValue: '1234.5678901234' });
      await row(tx, user.id, b.id, base.id, '2026-03-02', { totalValue: '0.0000000001' });
      await row(tx, user.id, c.id, base.id, '2026-03-02', { totalValue: '99999999.9999999999' });
      // Day 2: incomplete PnL, one partial, one stale, one pre-provenance NULL,
      // two anchors, one unpriceable holding.
      await row(tx, user.id, a.id, base.id, '2026-03-03', {
        costBasis: null,
        coverageQuality: 'partial',
        oldestAnchorAt: new Date('2026-02-20T10:00:00.000Z'),
      });
      await row(tx, user.id, b.id, base.id, '2026-03-03', {
        holdingsStalePriced: 1,
        holdingsStaleAnchored: null,
        oldestAnchorAt: new Date('2026-02-10T08:30:00.000Z'),
      });
      await row(tx, user.id, c.id, base.id, '2026-03-03', {
        holdingsUnpriceable: 1,
        holdingsWithKnownValue: 0,
        totalValue: '0',
      });
      await row(tx, user.id, d.id, base.id, '2026-03-03', {
        holdingsBeforeRecords: null,
        holdingsBasisUnknown: 1,
        transfersUnreviewed: 2,
      });
      // Day 3: only an unpriceable holding, so nothing priceable was measured.
      await row(tx, user.id, d.id, base.id, '2026-03-04', {
        holdingsUnpriceable: 1,
        holdingsWithKnownValue: 0,
        totalValue: '0',
      });
      // Rows the inclusion contract must drop, on a day that is otherwise kept.
      await row(tx, user.id, hidden.id, base.id, '2026-03-02', { totalValue: '5000' });
      await row(tx, user.id, inactive.id, base.id, '2026-03-02', { totalValue: '7000' });
      await row(tx, user.id, a.id, other.id, '2026-03-02', { totalValue: '9000' });
      await row(tx, user.id, user.id, base.id, '2026-03-02', {
        scopeKind: 'user',
        totalValue: '11000',
      });

      const perHolding = await repo().findIncludedHoldingScopeRange(user.id, base.id, FROM, TO, tx);
      const legacy = legacyAggregateIncludedHoldingRows(perHolding);
      const next = aggregateDailyTotals(
        await repo().findIncludedHoldingDailyTotals(user.id, base.id, FROM, TO, tx)
      );

      expect(next).toEqual(legacy);
      // The comparison is only worth something if the fixture reached the
      // branches: three days, the precise sum, a null PnL, both null counts,
      // the earlier anchor, and all three coverage verdicts.
      expect(legacy.map((p) => p.snapshotDate)).toEqual(['2026-03-02', '2026-03-03', '2026-03-04']);
      expect(legacy[0]?.totalValue).toBe('100001234.5678901234');
      expect(legacy[1]?.costBasis).toBeNull();
      expect(legacy[1]?.holdingsStaleAnchored).toBeNull();
      expect(legacy[1]?.holdingsBeforeRecords).toBeNull();
      expect(legacy[1]?.oldestAnchorAt).toBe('2026-02-10T08:30:00.000Z');
      expect(legacy.map((p) => p.coverageQuality)).toEqual(['full', 'partial', 'unknown']);
    });
  });

  test("Returns' narrow reader returns the same rows, minus the columns it never read", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const base = await makeToken(tx);
      const inst = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const a = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: base.id });
      const b = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: base.id });
      await row(tx, user.id, a.id, base.id, '2026-03-02', { holdingsStaleAnchored: null });
      await row(tx, user.id, b.id, base.id, '2026-03-02', { coverageQuality: 'partial' });
      await row(tx, user.id, a.id, base.id, '2026-03-03', { holdingsInterpolated: 2 });

      const wide = await repo().findIncludedHoldingScopeRange(user.id, base.id, FROM, TO, tx);
      const narrow = await repo().findIncludedHoldingValueRange(
        user.id,
        base.id,
        FROM,
        TO,
        undefined,
        tx
      );

      const key = (r: { snapshotDate: string; holdingId: string }) =>
        `${r.snapshotDate}|${r.holdingId}`;
      const pick = (r: (typeof wide)[number]) => ({
        snapshotDate: r.snapshotDate,
        holdingId: r.holdingId,
        totalValue: r.totalValue,
        coverageQuality: r.coverageQuality,
        holdingsWithKnownValue: r.holdingsWithKnownValue,
        holdingsTotal: r.holdingsTotal,
        holdingsStalePriced: r.holdingsStalePriced,
        holdingsStaleAnchored: r.holdingsStaleAnchored,
        holdingsBeforeRecords: r.holdingsBeforeRecords,
        holdingsInterpolated: r.holdingsInterpolated,
        transfersUnreviewed: r.transfersUnreviewed,
      });
      expect(wide).toHaveLength(3);
      expect([...narrow].sort((x, y) => key(x).localeCompare(key(y)))).toEqual(
        wide.map(pick).sort((x, y) => key(x).localeCompare(key(y)))
      );
    });
  });
});
