import { DEFAULT_COST_BASIS_METHOD, Decimal, DISPOSAL_OUTCOMES } from '@scani/shared';
import { Container, Service } from 'typedi';
import type { CostBasisMethod } from '../../lib/lot-matching';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import type {
  CostBasisQuality,
  DisposalLotMatch,
  DisposalOutcome,
} from '../pricing/CostBasisService';
import { RealizedLedgerService } from './RealizedLedgerService';

/**
 * The window a set of disposals is reported over. Half-open: `from` inclusive,
 * `to` exclusive, so two adjacent windows partition disposals exactly and a
 * disposal on a boundary is counted once rather than twice.
 */
export interface DisposalWindow {
  from: Date;
  to: Date;
}

export interface DisposalTotals {
  /** Sum of the non-null `proceeds`. */
  proceeds: Decimal;
  /** Sum of every `costBasis`, zeroes included. */
  costBasis: Decimal;
  /** Sum of the non-null `gain`. Deliberately not `proceeds - costBasis` —
   *  those two are summed over different subsets of the rows. */
  gain: Decimal;
}

export interface PeriodDisposalsResult {
  rows: DisposalLotMatch[];
  totals: DisposalTotals;
  /** Every outcome present with a zero, so the buckets sum to `rows.length`. */
  byOutcome: Record<DisposalOutcome, number>;
  byBasisQuality: Record<CostBasisQuality, number>;
  method: CostBasisMethod;
}

const BASIS_QUALITIES: readonly CostBasisQuality[] = ['known', 'partial', 'unknown'];

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

/**
 * "What did my disposals do over this window?" — across the whole portfolio
 * (SC-90).
 *
 * `RealizedLedgerService` answers the same question for one holding, and
 * `forComponentsOf` already walks a set of holdings correctly. What was missing
 * is the two things that turn that into a portfolio-over-a-period answer: the
 * enumeration of a user's holdings, and a LOWER bound on the rows. This is
 * those two, and nothing else — the arithmetic is entirely the existing walk's.
 *
 * **Not tax output, and it may not become it.** See
 * `docs/technical/2026-08-14_why-no-tax-statement.md`, and the same note on
 * `RealizedLedgerService` and on the `period-disposals` contract. The window is
 * two instants rather than a year number precisely so nothing here encodes a
 * jurisdiction's idea of where a year begins.
 *
 * ## The two bounds are NOT symmetric, and this is the whole of the design
 *
 * The window bounds what is REPORTED. It must not bound what is WALKED, and the
 * two ends fail differently if it does:
 *
 * - **Lower bound.** A lot bought in 2019 is what supplies the cost basis of a
 *   2024 sale. Starting the walk at `from` would find no acquisition to match,
 *   report a zero basis, and book the entire proceeds as gain — for every row,
 *   in one direction, plausibly. So the walk always runs from the beginning of
 *   the holding's history and `from` is applied to its OUTPUT.
 * - **Upper bound.** `at` truncates the walk's INPUT, and under
 *   `uk_section_104` matching runs FORWARDS: a disposal is identified with
 *   acquisitions in the following 30 days. Passing `to` as `at` would therefore
 *   truncate that forward window for every disposal in the last month of the
 *   period and match them against the pool instead. So the walk runs to `asOf`
 *   — the caller's "as of when do we know things", defaulting to now — and the
 *   window's upper end is applied to the output alongside its lower one.
 *
 * Consequence worth stating rather than discovering: this is a QUERY, not a
 * snapshot. Re-asking about a closed window after a backfill can return
 * different figures, because the walk it rides on will have seen more history.
 * Nothing here records what it previously said.
 */
@Service()
export class PeriodDisposalsService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly realizedLedgerService = Container.get(RealizedLedgerService);

  /**
   * Every disposal row in `window`, newest first, over every holding the user
   * has.
   *
   * Ownership is enforced here rather than assumed: `findIdsForUser` is the
   * only source of the holding set, so a caller cannot widen it.
   *
   * Hidden, inactive and scam-flagged holdings are deliberately INCLUDED. A
   * disposal out of a position somebody later hid is still a disposal that
   * happened, and a total that quietly omits it is the failure this whole
   * ledger exists to avoid. `findIdsForUser` applies no such filter and this
   * does not add one.
   */
  async forPeriod(
    userId: string,
    baseCurrencyId: string,
    window: DisposalWindow,
    method?: CostBasisMethod,
    asOf: Date = new Date()
  ): Promise<PeriodDisposalsResult> {
    const holdingIds = await this.holdingRepository.findIdsForUser(userId);

    // `forComponentsOf` collapses seeds that share a transfer component, so
    // handing it every holding walks each component once — which is what makes
    // a coin bought on an exchange and sold from a wallet appear here with the
    // cost it was actually bought at.
    const ledger =
      holdingIds.length === 0
        ? []
        : await this.realizedLedgerService.forComponentsOf(
            userId,
            holdingIds,
            baseCurrencyId,
            asOf,
            method
          );

    const from = window.from.getTime();
    const to = window.to.getTime();
    const rows = ledger.filter((row) => {
      const at = row.disposedAt.getTime();
      return at >= from && at < to;
    });

    const byOutcome = zeroed<DisposalOutcome>(DISPOSAL_OUTCOMES);
    const byBasisQuality = zeroed<CostBasisQuality>(BASIS_QUALITIES);
    let proceeds = new Decimal(0);
    let costBasis = new Decimal(0);
    let gain = new Decimal(0);

    for (const row of rows) {
      byOutcome[row.outcome] += 1;
      byBasisQuality[row.basisQuality] += 1;
      if (row.proceeds) proceeds = proceeds.add(row.proceeds);
      costBasis = costBasis.add(row.costBasis);
      if (row.gain) gain = gain.add(row.gain);
    }

    return {
      rows,
      totals: { proceeds, costBasis, gain },
      byOutcome,
      byBasisQuality,
      // Echoed back so a reader of the result never has to know what the walk
      // defaulted to. Imported rather than spelled again: a second literal
      // here would report `fifo` on the day the default changes underneath it,
      // and the figure it labels would be the other method's.
      method: method ?? DEFAULT_COST_BASIS_METHOD,
    };
  }
}
