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
 * Memoised per holding within a preloaded transaction map, because the rollup
 * asks once per day with the same caches and a holding's answer does not depend
 * on the day. The answer is exactly the holdings asked about: a caller spreads
 * every value it gets, so another holding's rows would count as its money in
 * or out (SC-1553).
 */
@Service()
export class DriftLedgerService {
  private readonly observationRepository = Container.get(HoldingBalanceObservationRepository);
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly memo = new WeakMap<object, Map<string, HoldingTransaction[] | null>>();

  async forHoldings(
    userId: string,
    tokenByHolding: ReadonlyMap<string, string>,
    opts: {
      transactions?: ByHolding<HoldingTransaction>;
      tx: DatabaseTransaction | undefined;
    }
  ): Promise<Map<string, HoldingTransaction[]>> {
    const memoKey = opts.transactions;
    const known = memoKey ? (this.memo.get(memoKey) ?? new Map()) : new Map();
    if (memoKey) this.memo.set(memoKey, known);
    const missing = [...tokenByHolding.keys()].filter((holdingId) => !known.has(holdingId));
    if (missing.length > 0) {
      const [transactions, observations] = await Promise.all([
        opts.transactions ?? this.txRepository.findForHoldingsAll(missing, opts.tx),
        this.observationRepository.findReadingsForHoldings(missing, opts.tx),
      ]);
      for (const holdingId of missing) {
        const readings = observations.get(holdingId) ?? [];
        const rows =
          readings.length === 0
            ? []
            : driftRows(
                { holdingId, tokenId: tokenByHolding.get(holdingId) as string },
                readings.map((r) => ({ ...r, gapReview: r.gapReview ?? null })),
                transactions.get(holdingId) ?? []
              );
        known.set(holdingId, rows.length > 0 ? asLedgerRows(rows, userId) : null);
      }
    }
    const out = new Map<string, HoldingTransaction[]>();
    for (const holdingId of tokenByHolding.keys()) {
      const rows = known.get(holdingId);
      if (rows) out.set(holdingId, rows);
    }
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
