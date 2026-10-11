import type { HoldingTransaction } from '@scani/db/schema';
import { feeShareOf } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import {
  commissionCrossesInto,
  flowRoleOfRow,
  rowIdsByHolding,
} from '../../lib/returns/flow-classification';
import {
  type ValuationBasis,
  valuationInstantsOf,
  valueRowInBase,
  valueTradeFeeInBase,
} from '../../lib/tx-valuation';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { PriceReader, type PriceSeries } from '../pricing/PriceReader';
import { DriftLedgerService } from './DriftLedgerService';
import type { WeightedHolding } from './ReturnsScopeResolver';
import type { ReturnsSharedLoads } from './ReturnsSharedLoads';

/**
 * One movement of money across a scope's boundary, in base currency — plus,
 * since SC-510, the `restatement` rows that are not movements at all.
 *
 * A `correction` is carried here because the value series moved and TWR has to
 * subtract that movement from the closing value or it reads as a gain. It is
 * NOT a cashflow, and `toCashflows` in `ReturnsService` drops it by role.
 * `kind` travels on every row, so a consumer that needs the distinction asks
 * `flowRoleOf` rather than being handed a second, differently-computed flag.
 *
 * Kept as a ROW rather than reduced straight to a daily number, and that is a
 * decision about SC-458 (splitting asset return from FX return) rather than
 * about this ticket. SC-458 has to re-value the same movements in their own
 * currencies and difference the two; if the only thing that survived here were
 * a base-currency total per day, it would have to re-read and re-classify the
 * whole ledger to get back what this already computed. So the token, the
 * signed quantity, the route that valued it and the instant it happened all
 * travel with the amount, and `netFlowByDate` — a pure fold over these rows —
 * is what the return math consumes.
 */
export interface ExternalFlow {
  transactionId: string;
  holdingId: string;
  kind: string;
  occurredAt: Date;
  tokenId: string;
  /**
   * Signed token quantity that CROSSED THE BOUNDARY — the ledger's own, less
   * any share of it the reader answered `fee` (SC-888).
   *
   * It read "exactly as the ledger records it" until then, and the two are the
   * same on every row but a fee-answered outflow. The distinction matters
   * because SC-458 re-values these quantities in their own currencies and
   * differences the two series: handing it the gross quantity beside a
   * fee-netted `baseAmount` would put the charge into the FX residual, which
   * is the one place nothing would look for it.
   */
  quantity: string;
  /**
   * Signed base-currency amount, POSITIVE into the scope, already multiplied
   * by the holding's scope weight.
   */
  baseAmount: string;
  /** Which route valued it, or `null` when nothing could — see `unvalued`. */
  valuationBasis: ValuationBasis | null;
  /** The price behind `baseAmount` was outside the freshness window (SC-151). */
  stale: boolean;
  /** The scope weight applied. `1` outside vaults. */
  weight: string;
}

export interface ExternalFlowSeries {
  flows: ExternalFlow[];
  /**
   * Rows that crossed the boundary and that NOTHING could value — no
   * execution rate, no price route for the held token.
   *
   * They contribute 0 to the flow total, which means their effect on the
   * value series is attributed to PERFORMANCE. That is the one way this
   * engine can be quietly wrong, so the count is carried out to the caller
   * and onto the wire rather than logged and forgotten. It is the direct
   * descendant of SC-149: a zero that nobody measured, presented beside
   * numbers that were.
   */
  unvaluedCount: number;
  /** Of `flows`, how many rest on a price beyond the staleness cap. */
  staleValuedCount: number;
  unresolvedCount: number;
  /**
   * The same three counts, by the holding they belong to, so a scope can
   * leave out the holdings it cannot measure instead of withholding every
   * holding's return for one of them (SC-1421).
   */
  problemsByHolding: Map<string, Set<FlowProblem>>;
}

export type FlowProblem = 'unvalued' | 'stale' | 'unresolved';

@Service()
export class ExternalFlowService {
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly priceReader = Container.get(PriceReader);
  private readonly driftLedgerService = Container.get(DriftLedgerService);

  async forHoldings(
    holdings: readonly WeightedHolding[],
    baseCurrencyId: string,
    from: Date,
    to: Date,
    now: Date = new Date(),
    shared?: ReturnsSharedLoads
  ): Promise<ExternalFlowSeries> {
    if (holdings.length === 0)
      return {
        flows: [],
        unvaluedCount: 0,
        staleValuedCount: 0,
        unresolvedCount: 0,
        problemsByHolding: new Map(),
      };

    // A holding's flows count exactly when its value and PnL do: the value
    // series reads only holdings the inclusion rule admits, and a flow on one it
    // leaves out stood beside no value at all (SC-1486).
    const included = await this.holdingRepository.findIdsIncludedInTotal(
      holdings.map((h) => h.holdingId)
    );
    const weights = new Map(
      holdings.filter((h) => included.has(h.holdingId)).map((h) => [h.holdingId, h.weight])
    );
    const holdingIds = [...weights.keys()];
    if (holdingIds.length === 0)
      return {
        flows: [],
        unvaluedCount: 0,
        staleValuedCount: 0,
        unresolvedCount: 0,
        problemsByHolding: new Map(),
      };
    const [ledger, holdingRows] = await Promise.all([
      this.txRepository.findForHoldingsInRange(holdingIds, from, to),
      this.holdingRepository.findByIds(holdingIds),
    ]);
    // An unexplained balance change is money in or out, never return (SC-1470,
    // mgrin 2026-10-01): its rows join the ledger's here, inside `(from, to]`.
    // Only for a holding the value series counts: an inactive one is never
    // valued (SC-1328), so its opening would be money in with no value beside it.
    const drift = await this.driftLedgerService.forHoldings(
      holdingRows[0]?.userId ?? '',
      new Map(holdingRows.filter((row) => row.isActive).map((row) => [row.id, row.tokenId])),
      { tx: undefined, shared: shared?.driftByHolding }
    );
    const transactions = [
      ...ledger,
      ...[...drift.values()].flat().filter((row) => row.occurredAt > from && row.occurredAt <= to),
    ];
    // Nothing crossed the boundary, so there is nothing to value and no
    // reason to pay for a prefetch. Most accounts in the product are here.
    if (transactions.length === 0)
      return {
        flows: [],
        unvaluedCount: 0,
        staleValuedCount: 0,
        unresolvedCount: 0,
        problemsByHolding: new Map(),
      };

    const heldTokenByHolding = new Map(holdingRows.map((row) => [row.id, row.tokenId]));

    // One series over every instant the valuations below read. Each flow is
    // read at `flowValuationInstant`, which only ever moves an instant FORWARD
    // to the end of its own day, or at its own instant (D-10).
    const heldOf = (tx: HoldingTransaction) =>
      heldTokenByHolding.get(tx.holdingId) ?? tx.tokenId ?? null;
    const prices = await this.priceReader.series(
      transactions.flatMap((tx) => valuationInstantsOf(tx, baseCurrencyId, heldOf(tx), now)),
      baseCurrencyId
    );

    const flows: ExternalFlow[] = [];
    let unvaluedCount = 0;
    let staleValuedCount = 0;
    const problemsByHolding = new Map<string, Set<FlowProblem>>();
    const flag = (holdingId: string, problem: FlowProblem) => {
      const set = problemsByHolding.get(holdingId) ?? new Set<FlowProblem>();
      set.add(problem);
      problemsByHolding.set(holdingId, set);
    };
    const unresolved = transactions.filter(
      (tx) =>
        tx.kind === 'unknown' ||
        ((tx.kind === 'withdraw' || tx.kind === 'transfer_out') &&
          !tx.transferGroupId &&
          (!tx.transferReview || tx.transferReview === 'unknown'))
    );
    for (const tx of unresolved) flag(tx.holdingId, 'unresolved');
    const unresolvedCount = unresolved.length;

    const idsByHolding = rowIdsByHolding(transactions);
    for (const tx of transactions) {
      // `return` rows are the portfolio earning or spending its own value and
      // never crossed a boundary. `restatement` rows did not cross one either,
      // but they DID move the reconstructed value series — see the note on
      // `ExternalFlow` — so they stay in and are dropped later, by role, only
      // where they would become a cashflow.
      if (flowRoleOfRow(tx, idsByHolding.get(tx.holdingId) ?? NO_IDS) === 'return') continue;
      const weight = weights.get(tx.holdingId);
      if (!weight) continue;

      // The share the reader called a charge is `return`, exactly as a
      // `kind='fee'` row is — see the note above. Subtracted from the
      // MAGNITUDE and never from the sign, so a fee larger than the row it
      // sits on (which the schema cannot see and therefore cannot refuse)
      // zeroes the flow rather than reversing its direction.
      const asRecorded = new Decimal(tx.quantity);
      if (asRecorded.isZero()) continue;
      // `.toString()` rather than the Decimal itself: `@scani/shared` ships the
      // project-configured clone and this file constructs `decimal.js`'s own,
      // and arithmetic between two clones is not something either promises.
      const fee = feeShareOf(tx.transferReview, tx.transferReviewSplit, tx.quantity).toString();
      const external = asRecorded.abs().minus(fee);
      if (external.lte(0)) continue;
      const quantity = asRecorded.isNegative() ? external.negated() : external;

      const valuation = valueRowInBase(prices, tx, external, baseCurrencyId, heldOf(tx), now);
      if (!valuation) {
        unvaluedCount += 1;
        flag(tx.holdingId, 'unvalued');
      } else if (valuation.stale) {
        staleValuedCount += 1;
        flag(tx.holdingId, 'stale');
      }

      // The ledger's own sign is the direction: negative quantity is value
      // leaving the holding. `valueTransactionInBase` works on magnitudes, so
      // the sign is re-applied here and nowhere else.
      //
      // A trade's commission is part of what crossed (SC-1470): a purchase put
      // the price AND the commission into the position, which is what the cost
      // walk books as its cost, and a sale took out the proceeds less it. The
      // cash that paid it leaves through its own settling `fee` row.
      const commission =
        valuation &&
        TRADE_KINDS.has(tx.kind) &&
        commissionCrossesInto(tx, heldTokenByHolding.get(tx.holdingId) ?? tx.tokenId ?? null)
          ? commissionOf(prices, tx, baseCurrencyId, heldOf(tx), now)
          : new Decimal(0);
      const magnitude = valuation
        ? Decimal.max(
            0,
            quantity.isNegative()
              ? valuation.amount.minus(commission)
              : valuation.amount.add(commission)
          )
        : new Decimal(0);
      const signed = quantity.isNegative() ? magnitude.negated() : magnitude;

      flows.push({
        transactionId: tx.id,
        holdingId: tx.holdingId,
        kind: tx.kind,
        occurredAt: tx.occurredAt,
        tokenId: tx.tokenId,
        quantity: quantity.toString(),
        baseAmount: signed.mul(weight).toString(),
        valuationBasis: valuation ? valuation.basis : null,
        stale: valuation ? valuation.stale : false,
        weight: weight.toString(),
      });
    }

    return { flows, unvaluedCount, staleValuedCount, unresolvedCount, problemsByHolding };
  }
}

// `holding_transactions.token_id` is documented as kept in sync with the
// holding's token, and the holding row is the authority when a bad ingester
// lets the two drift: `heldOf` falls back to the row's own token rather than
// refusing to value it.
function commissionOf(
  prices: PriceSeries,
  tx: HoldingTransaction,
  baseCurrencyId: string,
  heldTokenId: string | null,
  now: Date
): Decimal {
  return (
    valueTradeFeeInBase(prices, tx, baseCurrencyId, heldTokenId, now)?.amount ?? new Decimal(0)
  );
}

const TRADE_KINDS: ReadonlySet<string> = new Set(['buy', 'sell']);
const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Fold flows onto the measured days that can carry them.
 *
 * A flow is attributed to the FIRST measured day at or after its own date, not
 * to its own date. The rollup does not write a row for every calendar day —
 * gaps are normal, and `hasKnownCoverage` drops more — so a flow landing on an
 * unmeasured day would otherwise vanish, and a vanished contribution reads as
 * a gain of exactly its own size.
 *
 * Flows after the last measured day have no period to belong to and are
 * returned separately rather than folded into the final one, where they would
 * corrupt a return the series cannot see the end of.
 */
export function netFlowByDate(
  flows: readonly ExternalFlow[],
  measuredDates: readonly string[],
  /**
   * `holdingId -> currency token id`, or `null` where nothing could place the
   * asset. Supplied by SC-458 so the same fold produces the per-currency split
   * the FX attribution needs; omit it and only `byDate` is populated.
   *
   * The flow is bucketed by the currency of the HOLDING it moved, not of the
   * token named on the transaction row. The value series is bucketed the same
   * way, and a flow booked into a bucket its value never entered would leave
   * both legs wrong in opposite directions.
   */
  currencyByHolding?: ReadonlyMap<string, string | null>
): {
  byDate: Map<string, Decimal>;
  byDateAndCurrency: Map<string, Map<string | null, Decimal>>;
  unattributed: ExternalFlow[];
} {
  const byDate = new Map<string, Decimal>();
  const byDateAndCurrency = new Map<string, Map<string | null, Decimal>>();
  const unattributed: ExternalFlow[] = [];
  const sortedDates = [...measuredDates].sort();
  for (const date of sortedDates) {
    byDate.set(date, new Decimal(0));
    byDateAndCurrency.set(date, new Map());
  }

  for (const flow of flows) {
    const flowDate = flow.occurredAt.toISOString().slice(0, 10);
    const target = sortedDates.find((date) => date >= flowDate);
    if (target === undefined) {
      unattributed.push(flow);
      continue;
    }
    const amount = new Decimal(flow.baseAmount);
    byDate.set(target, (byDate.get(target) as Decimal).add(amount));
    if (!currencyByHolding) continue;
    const currency = currencyByHolding.get(flow.holdingId) ?? null;
    const bucket = byDateAndCurrency.get(target) as Map<string | null, Decimal>;
    bucket.set(currency, (bucket.get(currency) ?? new Decimal(0)).add(amount));
  }

  return { byDate, byDateAndCurrency, unattributed };
}
