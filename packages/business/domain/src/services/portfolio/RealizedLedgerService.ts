import type { HoldingTransaction } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { HoldingCoverageRepository } from '../../repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import {
  CostBasisService,
  type DisposalLotMatch,
  type HistoryCompleteness,
  historyCompletenessOf,
} from '../pricing/CostBasisService';

/**
 * "Why did my realized gain change?" — answered for one holding (SC-152).
 *
 * `CostBasisService` accumulates realized PnL as a scalar, so today the figure
 * on the screen has nothing behind it. The walk knows the matched lot, its
 * acquisition date, the cost popped and the proceeds at the moment it books a
 * gain, and then adds them to a running total and forgets them. This asks the
 * same walk to keep its working.
 *
 * **This is not tax output and must not become it.** See
 * `docs/technical/2026-08-14_why-no-tax-statement.md`: the ledger underneath is
 * not tax-grade for eleven separate reasons, and a document that looks
 * authoritative gets filed. What this returns is the arithmetic already on the
 * screen, shown rather than asserted.
 *
 * ## Cost
 *
 * Nothing recurring. There is no table, no migration, no job — the ledger is
 * computed on the read, only when somebody opens a record, and the walk it
 * rides on is the one the rollup already performs nightly without collecting.
 * Passing no `collect` array is what keeps that hot path at exactly its
 * current cost.
 *
 * The one thing worth stating plainly is the *shape* of the read. A
 * transfer-linked holding cannot be walked alone — a lot sold on a hardware
 * wallet may have been bought on an exchange — so this walks the holding's
 * whole transfer component. `PnLAtTimeService` reaches the same conclusion by
 * partitioning the entire portfolio, which is right when it is about to walk
 * all of it anyway; here that would mean reading every transaction the user
 * has in order to answer a question about one holding. So the component is
 * expanded outward from the holding instead
 * (`findTransferLinkedHoldingIds`), and for the common case — a holding with
 * no linked transfers at all — the read is exactly that holding's own history.
 */
@Service()
export class RealizedLedgerService {
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly coverageRepository = Container.get(HoldingCoverageRepository);
  private readonly costBasisService = Container.get(CostBasisService);

  /**
   * Every lot match against this holding's outflows at or before `at`, newest
   * disposal first.
   *
   * Ordering is applied here rather than left to the walk. `walkComponent`
   * emits half-linked outflows in an end-of-walk pass, so its natural order is
   * chronological-except-for-a-tail — correct, and not what anyone reading a
   * list expects.
   *
   * Ownership is the caller's to check. Passing `userId` here scopes the
   * component expansion, which is a second fence rather than the first one.
   */
  async forHolding(
    userId: string,
    holdingId: string,
    baseCurrencyId: string,
    at: Date = new Date()
  ): Promise<DisposalLotMatch[]> {
    const componentIds = await this.txRepository.findTransferLinkedHoldingIds(userId, [holdingId]);
    const [txsByHolding, holdings, coverageByHolding] = await Promise.all([
      this.txRepository.findForHoldingsAll(componentIds),
      this.holdingRepository.findByIds(componentIds),
      this.coverageRepository.findManyByHoldingIds(componentIds),
    ]);
    const heldTokenByHolding = new Map(holdings.map((h) => [h.id, h.tokenId]));
    const historyByHolding = new Map<string, HistoryCompleteness>(
      componentIds.map((h) => [h, historyCompletenessOf(coverageByHolding.get(h))])
    );

    const ledger: DisposalLotMatch[] = [];
    if (componentIds.length === 1) {
      await this.costBasisService.getCostBasis(holdingId, at, baseCurrencyId, {
        heldTokenId: heldTokenByHolding.get(holdingId) ?? undefined,
        historyCompleteness: historyByHolding.get(holdingId) ?? 'unrecorded',
        txs: txsByHolding.get(holdingId) ?? ([] as ReadonlyArray<HoldingTransaction>),
        collect: ledger,
      });
    } else {
      await this.costBasisService.walkComponent(
        componentIds,
        txsByHolding,
        at,
        baseCurrencyId,
        heldTokenByHolding,
        undefined,
        historyByHolding,
        ledger
      );
    }

    return ledger
      .filter((row) => row.holdingId === holdingId)
      .sort((a, b) => b.disposedAt.getTime() - a.disposedAt.getTime());
  }
}
