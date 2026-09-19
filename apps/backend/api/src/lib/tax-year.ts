import { taxYearWindow, taxYearZone } from '@scani/domain/lib/tax-year';
import { IncomeService, PeriodDisposalsService } from '@scani/domain/services';
import {
  parseCostBasisMethod,
  type TaxYearDisposals,
  type TaxYearStart,
  toDisposalLotMatchDto,
} from '@scani/shared';
import { Container } from 'typedi';

interface TaxYearUser {
  id: string;
  baseCurrencyId: string | null;
  costBasisMethod: string | null;
  timezone: string | null;
}

/**
 * One tax year's disposals and income for a user — SC-90. Shared by
 * `portfolio.taxYear` (the screen) and `exports.taxYearPdf` (the document), so
 * the two cannot show different figures for the same year.
 */
export async function computeTaxYear(
  dbUser: TaxYearUser,
  input: { year: number; yearStart: TaxYearStart }
): Promise<TaxYearDisposals> {
  const baseCurrencyId = dbUser.baseCurrencyId ?? null;
  const method = parseCostBasisMethod(dbUser.costBasisMethod);
  const zone = taxYearZone(dbUser.timezone ?? null);
  const window = taxYearWindow(input.year, input.yearStart, zone.timeZone);
  const header = {
    generatedAt: new Date().toISOString(),
    periodStart: window.from.toISOString(),
    periodEnd: window.to.toISOString(),
    taxYear: {
      year: input.year,
      yearStart: input.yearStart,
      timeZone: zone.timeZone,
      timeZoneSource: zone.source,
    },
  };
  if (!baseCurrencyId) {
    // Every figure is denominated in the base currency, so without one
    // there is no ledger to report — not an empty one.
    return {
      ...header,
      income: {
        rows: [],
        totals: { interest: '0', reward: '0' },
        unvalued: { interest: 0, reward: 0, airdrop: 0 },
      },
      baseCurrencyId: null,
      costBasisMethod: method,
      rows: [],
      rowCount: 0,
      byOutcome: { realized: 0, unpriced: 0, unreviewed: 0, retained: 0, awaiting_pair: 0 },
      byBasisQuality: { known: 0, partial: 0, unknown: 0 },
      totals: { proceeds: '0', costBasis: '0', gain: '0' },
    };
  }
  const [result, income] = await Promise.all([
    Container.get(PeriodDisposalsService).forPeriod(dbUser.id, baseCurrencyId, window, method),
    Container.get(IncomeService).forPeriod(dbUser.id, baseCurrencyId, window),
  ]);
  return {
    ...header,
    income: {
      rows: income.rows.map((row) => ({
        transactionId: row.transactionId,
        holdingId: row.holdingId,
        tokenId: row.tokenId,
        kind: row.kind,
        receivedAt: row.receivedAt.toISOString(),
        quantity: row.quantity.toString(),
        value: row.value?.toString() ?? null,
        stale: row.stale,
      })),
      totals: {
        interest: income.totals.interest.toString(),
        reward: income.totals.reward.toString(),
      },
      unvalued: income.unvalued,
    },
    baseCurrencyId,
    costBasisMethod: result.method,
    rows: result.rows.map(toDisposalLotMatchDto),
    rowCount: result.rows.length,
    byOutcome: result.byOutcome,
    byBasisQuality: result.byBasisQuality,
    totals: {
      proceeds: result.totals.proceeds.toString(),
      costBasis: result.totals.costBasis.toString(),
      gain: result.totals.gain.toString(),
    },
  };
}
