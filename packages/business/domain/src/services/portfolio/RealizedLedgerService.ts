import type { HoldingTransaction } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { HoldingCoverageRepository } from '../../repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import {
  type CostBasisMethod,
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
    at: Date = new Date(),
    method?: CostBasisMethod
  ): Promise<DisposalLotMatch[]> {
    const componentIds = await this.txRepository.findTransferLinkedHoldingIds(userId, [holdingId]);
    const ledger = await this.walkOneComponent(componentIds, baseCurrencyId, at, method);

    return ledger
      .filter((row) => row.holdingId === holdingId)
      .sort((a, b) => b.disposedAt.getTime() - a.disposedAt.getTime());
  }

  /**
   * Every lot match in every transfer component these holdings belong to —
   * the whole answer rather than one holding's slice of it (SC-379).
   *
   * `forHolding` walks the component and then keeps `row.holdingId ===
   * holdingId`, so the per-holding results PARTITION the component. That makes
   * one holding a perfectly good handle to walk *by* and a terrible one to
   ***REMOVED***
   ***REMOVED***
   ***REMOVED***
   * summed one representative per component and called it the component's
   * realized PnL.
   *
   * Those figures were not small versions of the truth, they were ARBITRARY:
   * which holding survived depended on `Set` insertion order, so the same
   * question asked twice could answer with a different magnitude and a
   * different SIGN. Re-derived on production 2026-08-18, SC-328's delta is
   ***REMOVED***
   ***REMOVED***
   ***REMOVED***
   *
   * So this walks each distinct component ONCE and returns everything it
   * emits. No cross-holding de-duplication is applied or needed, and none
   * should be added: two lot matches of one transaction can be identical in
   * every field `DisposalLotMatch` exposes (same portion, same acquisition
   * instant, same quantity) and production has such a pair, so a set of field
   * tuples would silently drop a real row.
   */
  async forComponentsOf(
    userId: string,
    holdingIds: ReadonlyArray<string>,
    baseCurrencyId: string,
    at: Date = new Date(),
    method?: CostBasisMethod
  ): Promise<DisposalLotMatch[]> {
    const components: string[][] = [];
    const covered = new Set<string>();
    for (const holdingId of holdingIds) {
      if (covered.has(holdingId)) continue;
      const componentIds = await this.txRepository.findTransferLinkedHoldingIds(userId, [
        holdingId,
      ]);
      // `findTransferLinkedHoldingIds` walks transfer groups to a fixpoint, so
      // this set is the whole component and every member of it is now covered.
      // Seeds sharing a component therefore collapse to one walk — which is
      // what the representative optimisation was reaching for, and is safe
      // here because the walk's OUTPUT is no longer thrown away.
      for (const id of componentIds) covered.add(id);
      components.push(componentIds);
    }

    const ledger: DisposalLotMatch[] = [];
    for (const componentIds of components) {
      ledger.push(...(await this.walkOneComponent(componentIds, baseCurrencyId, at, method)));
    }
    return ledger.sort((a, b) => b.disposedAt.getTime() - a.disposedAt.getTime());
  }

  /** The walk itself, unfiltered: every row the component emits at or before `at`. */
  private async walkOneComponent(
    componentIds: ReadonlyArray<string>,
    baseCurrencyId: string,
    at: Date,
    method?: CostBasisMethod
  ): Promise<DisposalLotMatch[]> {
    const ids = [...componentIds];
    const [txsByHolding, holdings, coverageByHolding] = await Promise.all([
      this.txRepository.findForHoldingsAll(ids),
      this.holdingRepository.findByIds(ids),
      this.coverageRepository.findManyByHoldingIds(ids),
    ]);
    const heldTokenByHolding = new Map(holdings.map((h) => [h.id, h.tokenId]));
    const historyByHolding = new Map<string, HistoryCompleteness>(
      ids.map((h) => [h, historyCompletenessOf(coverageByHolding.get(h))])
    );

    const ledger: DisposalLotMatch[] = [];
    const only = ids.length === 1 ? ids[0] : undefined;
    if (only !== undefined) {
      await this.costBasisService.getCostBasis(only, at, baseCurrencyId, {
        heldTokenId: heldTokenByHolding.get(only) ?? undefined,
        historyCompleteness: historyByHolding.get(only) ?? 'unrecorded',
        txs: txsByHolding.get(only) ?? ([] as ReadonlyArray<HoldingTransaction>),
        collect: ledger,
        ...(method ? { method } : {}),
        tx: undefined,
      });
    } else {
      await this.costBasisService.walkComponent(
        undefined,
        ids,
        txsByHolding,
        at,
        baseCurrencyId,
        heldTokenByHolding,
        undefined,
        historyByHolding,
        ledger,
        method
      );
    }
    return ledger;
  }
}
