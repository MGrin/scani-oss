import { Decimal } from '@scani/shared';
import { Container, Service } from 'typedi';
import { valueTransactionInBase } from '../../lib/tx-valuation';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { PriceGraphService } from '../pricing/PriceGraphService';
import type { DisposalWindow } from './PeriodDisposalsService';

type IncomeKind = 'interest' | 'reward' | 'airdrop';

const INCOME_KINDS: readonly IncomeKind[] = ['interest', 'reward', 'airdrop'];

interface IncomeRow {
  transactionId: string;
  holdingId: string;
  tokenId: string;
  kind: IncomeKind;
  receivedAt: Date;
  quantity: Decimal;
  /** Base currency at receipt, or null when no price route resolved. */
  value: Decimal | null;
  /** The price behind `value` was outside the freshness window. */
  stale: boolean;
}

export interface IncomeResult {
  /** Oldest receipt first. */
  rows: IncomeRow[];
  /**
   * Interest and rewards only. Airdrops have no total by design (mgrin,
   * 2026-09-11): their treatment varies by country and their value at receipt
   * is often unknown, so a statement must not assert one.
   */
  totals: { interest: Decimal; reward: Decimal };
  /** Rows per kind with no value, which the totals above leave out. */
  unvalued: Record<IncomeKind, number>;
}

/**
 * Investment income over a window — SC-90's income section.
 *
 * Each receipt is valued with `valueTransactionInBase`, the valuation cost basis
 * gives the lot the same receipt opens, so the income figure and that lot's
 * cost cannot disagree. Hidden and scam-flagged holdings are included, on the
 * same reasoning `PeriodDisposalsService` gives: a receipt somebody later hid
 * still happened.
 */
@Service()
export class IncomeService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly priceGraphService = Container.get(PriceGraphService);

  async forPeriod(
    userId: string,
    baseCurrencyId: string,
    window: DisposalWindow
  ): Promise<IncomeResult> {
    const result: IncomeResult = {
      rows: [],
      totals: { interest: new Decimal(0), reward: new Decimal(0) },
      unvalued: { interest: 0, reward: 0, airdrop: 0 },
    };
    const holdingIds = await this.holdingRepository.findIdsForUser(userId);
    if (holdingIds.length === 0) return result;

    const holdings = await this.holdingRepository.findByIds(holdingIds);
    const tokenOf = new Map(holdings.map((h) => [h.id, h.tokenId]));
    const from = window.from.getTime();
    const to = window.to.getTime();
    // The repository answers `(from, to]`; widening its lower edge by a
    // millisecond and filtering here gives the window's `[from, to)`.
    const txs = await this.txRepository.findForHoldingsInRange(
      holdingIds,
      new Date(from - 1),
      window.to
    );

    for (const tx of txs) {
      const kind = tx.kind as IncomeKind;
      if (!INCOME_KINDS.includes(kind)) continue;
      const at = tx.occurredAt.getTime();
      if (at < from || at >= to) continue;
      const quantity = new Decimal(tx.quantity).abs();
      if (quantity.isZero()) continue;
      const heldTokenId = tokenOf.get(tx.holdingId) ?? null;
      const valued = await valueTransactionInBase(
        this.priceGraphService,
        undefined,
        tx,
        quantity,
        baseCurrencyId,
        heldTokenId
      );
      result.rows.push({
        transactionId: tx.id,
        holdingId: tx.holdingId,
        tokenId: heldTokenId ?? tx.tokenId,
        kind,
        receivedAt: tx.occurredAt,
        quantity,
        value: valued?.amount ?? null,
        stale: valued?.stale ?? false,
      });
      if (!valued) result.unvalued[kind] += 1;
      else if (kind !== 'airdrop') result.totals[kind] = result.totals[kind].add(valued.amount);
    }
    return result;
  }
}
