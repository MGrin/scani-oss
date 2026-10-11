import type { DatabaseTransaction } from '@scani/db';
import type { HoldingTransaction } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { asLedgerRows, driftRows } from '../../lib/balances/drift-rows';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { classifyHoldingEvidence } from '../foundation/legacy-classification';
import { PriceReader } from '../pricing/PriceReader';

type ByHolding<T> = ReadonlyMap<string, ReadonlyArray<T>>;

/** Whole histories held in memory at once, as history's batches (SC-1283). */
const EVIDENCE_BATCH = 25;

/**
 * The unexplained balance changes of a set of holdings, as ledger-shaped rows
 * for the readers of money (SC-1470), read from the engine's evidence so they
 * agree with the value series (SC-1637). `drift-rows.ts` says what they are and
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
  private readonly evidenceRepository = Container.get(EngineEvidenceRepository);
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly prices = Container.get(PriceReader);
  private readonly memo = new WeakMap<object, Map<string, HoldingTransaction[] | null>>();

  async forHoldings(
    userId: string,
    tokenByHolding: ReadonlyMap<string, string>,
    opts: {
      transactions?: ByHolding<HoldingTransaction>;
      tx: DatabaseTransaction | undefined;
      /**
       * Rows by holding, shared by callers in flight together (SC-1671): a
       * holding another caller is already reading is awaited, not read again.
       */
      shared?: Map<string, Promise<HoldingTransaction[] | null>>;
    }
  ): Promise<Map<string, HoldingTransaction[]>> {
    if (opts.shared) return this.forHoldingsShared(userId, tokenByHolding, opts.shared, opts.tx);
    const memoKey = opts.transactions;
    const known = memoKey ? (this.memo.get(memoKey) ?? new Map()) : new Map();
    if (memoKey) this.memo.set(memoKey, known);
    const missing = [...tokenByHolding.keys()].filter((holdingId) => !known.has(holdingId));
    if (missing.length > 0) {
      const loaded = await this.load(
        userId,
        new Map(missing.map((holdingId) => [holdingId, tokenByHolding.get(holdingId) as string])),
        opts.transactions,
        opts.tx
      );
      for (const [holdingId, rows] of loaded) known.set(holdingId, rows);
    }
    const out = new Map<string, HoldingTransaction[]>();
    for (const holdingId of tokenByHolding.keys()) {
      const rows = known.get(holdingId);
      if (rows) out.set(holdingId, rows);
    }
    return out;
  }

  private async forHoldingsShared(
    userId: string,
    tokenByHolding: ReadonlyMap<string, string>,
    shared: Map<string, Promise<HoldingTransaction[] | null>>,
    tx: DatabaseTransaction | undefined
  ): Promise<Map<string, HoldingTransaction[]>> {
    const missing = [...tokenByHolding.keys()].filter((holdingId) => !shared.has(holdingId));
    if (missing.length > 0) {
      const loading = this.load(
        userId,
        new Map(missing.map((holdingId) => [holdingId, tokenByHolding.get(holdingId) as string])),
        undefined,
        tx
      );
      for (const holdingId of missing) {
        shared.set(
          holdingId,
          loading.then((loaded) => loaded.get(holdingId) ?? null)
        );
      }
      // A failed read is not kept: the next caller reads again.
      loading.catch(() => {
        for (const holdingId of missing) shared.delete(holdingId);
      });
    }
    const ids = [...tokenByHolding.keys()];
    const rows = await Promise.all(ids.map((holdingId) => shared.get(holdingId)));
    const out = new Map<string, HoldingTransaction[]>();
    ids.forEach((holdingId, i) => {
      const found = rows[i];
      if (found) out.set(holdingId, found);
    });
    return out;
  }

  /** Every holding asked about, `null` where it has no drift rows. */
  private async load(
    userId: string,
    tokenByHolding: ReadonlyMap<string, string>,
    preloaded: ByHolding<HoldingTransaction> | undefined,
    tx: DatabaseTransaction | undefined
  ): Promise<Map<string, HoldingTransaction[] | null>> {
    const holdingIds = [...tokenByHolding.keys()];
    const known = new Map<string, HoldingTransaction[] | null>();
    const transactions = preloaded ?? (await this.txRepository.findForHoldingsAll(holdingIds, tx));
    const pricedFrom = await this.prices.firstReadingAt(
      holdingIds.map((holdingId) => tokenByHolding.get(holdingId) as string),
      tx
    );
    for (const holdingId of holdingIds) known.set(holdingId, null);
    for (let i = 0; i < holdingIds.length; i += EVIDENCE_BATCH) {
      // A run of identical checkpoints is read as its two ends (SC-1671):
      // every reading was 85,741 rows per request for one production user,
      // and the rows below come out the same.
      const raws = await this.evidenceRepository.findHoldingEvidence(
        { userId, holdingIds: holdingIds.slice(i, i + EVIDENCE_BATCH) },
        tx,
        { withoutRepeatedCheckpoints: true }
      );
      for (const raw of raws) {
        const holdingId = raw.holding.id;
        const tokenId = tokenByHolding.get(holdingId) as string;
        const rows = driftRows(
          { holdingId, tokenId },
          classifyHoldingEvidence(raw).evidence,
          transactions.get(holdingId) ?? [],
          new Map(raw.observations.map((o) => [o.id, o.gapReview ?? null])),
          pricedFrom.get(tokenId) ?? null
        );
        known.set(holdingId, rows.length > 0 ? asLedgerRows(rows, userId) : null);
      }
    }
    return known;
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
