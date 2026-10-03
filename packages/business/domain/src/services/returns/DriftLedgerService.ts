import type { DatabaseTransaction } from '@scani/db';
import type { HoldingTransaction } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { asLedgerRows, driftRows } from '../../lib/balances/drift-rows';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';

type ByHolding<T> = ReadonlyMap<string, ReadonlyArray<T>>;

/**
 * The unexplained balance changes of a set of holdings, as ledger-shaped rows
 * for the readers of money (SC-1470). `drift-rows.ts` says what they are and
 * why the balance walk must never be handed them.
 *
 * Memoised per preloaded transaction map, because the rollup asks once per day
 * with the same caches and the answer does not depend on the day.
 */
@Service()
export class DriftLedgerService {
  private readonly observationRepository = Container.get(HoldingBalanceObservationRepository);
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly memo = new WeakMap<object, Map<string, HoldingTransaction[]>>();

  async forHoldings(
    userId: string,
    tokenByHolding: ReadonlyMap<string, string>,
    opts: {
      transactions?: ByHolding<HoldingTransaction>;
      tx: DatabaseTransaction | undefined;
    }
  ): Promise<Map<string, HoldingTransaction[]>> {
    const memoKey = opts.transactions;
    const hit = memoKey ? this.memo.get(memoKey) : undefined;
    if (hit) return hit;
    const holdingIds = [...tokenByHolding.keys()];
    const [transactions, observations] = await Promise.all([
      opts.transactions ?? this.txRepository.findForHoldingsAll(holdingIds, opts.tx),
      this.observationRepository.findReadingsForHoldings(holdingIds, opts.tx),
    ]);
    const out = new Map<string, HoldingTransaction[]>();
    for (const [holdingId, tokenId] of tokenByHolding) {
      const readings = observations.get(holdingId) ?? [];
      if (readings.length === 0) continue;
      const ledger = transactions.get(holdingId) ?? [];
      const rows = driftRows(
        { holdingId, tokenId },
        readings.map((r) => ({ ...r, gapReview: r.gapReview ?? null })),
        ledger
      );
      if (rows.length > 0) out.set(holdingId, asLedgerRows(rows, userId));
    }
    if (memoKey) this.memo.set(memoKey, out);
    return out;
  }
}

/** `ledger` with `drift` merged in, each holding kept in time order. */
export function withDrift(
  ledger: ByHolding<HoldingTransaction>,
  drift: ReadonlyMap<string, ReadonlyArray<HoldingTransaction>>
): Map<string, HoldingTransaction[]> {
  const out = new Map<string, HoldingTransaction[]>();
  for (const [holdingId, rows] of ledger) out.set(holdingId, [...rows]);
  for (const [holdingId, rows] of drift) {
    // Drift first, so a stable sort keeps an opening ahead of a ledger row it shares an instant with.
    const merged = [...rows, ...(out.get(holdingId) ?? [])];
    merged.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    out.set(holdingId, merged);
  }
  return out;
}
