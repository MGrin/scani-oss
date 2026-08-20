import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { flowRoleOf } from '../../lib/returns/flow-classification';
import { type ValuationBasis, valueTransactionInBase } from '../../lib/tx-valuation';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { PriceGraphService } from '../pricing/PriceGraphService';
import type { PriceLookup } from '../pricing/PriceLookup';
import type { WeightedHolding } from './ReturnsScopeResolver';

/**
 * One movement of money across a scope's boundary, in base currency.
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
  /** Signed token quantity exactly as the ledger records it. */
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
}

/**
 * Every external flow into or out of a set of holdings, valued in base
 * currency at the instant it happened (SC-457).
 *
 * ## Why the signs cancel instead of a pairing lookup
 *
 * See `lib/returns/flow-classification.ts`. In short: the value series is
 * reconstructed from this same ledger, so a row on an in-scope holding has
 * already moved the scope's value; the two legs of an internal transfer are
 * both booked, carry opposite signs and equal base value, and cancel in the
 * sum. Nothing here needs to know they were a pair.
 *
 * ## Interval
 *
 * `(from, to]`, half-open at the start. A return window's sub-period runs from
 * the END of one measured day to the END of the next, and the anchor day's own
 * flows are already inside its value. Counting a transaction stamped exactly
 * on the anchor boundary would book it twice.
 *
 * ## `transfer_review` needs no handling here, including `'split'`
 *
 * A withdrawal answered `'untracked'` is the owner saying the asset is still
 * theirs in an account we cannot see. That is still value leaving the
 * MEASURED portfolio, so it is still an external outflow — the same as
 * `'left_control'`. A `'split'` divides one row between those two answers and
 * both halves are external, so the row's own quantity is the whole flow and
 * `transfer_review_split` never has to be read. The answer changes what is
 * REALIZED, which is a different question and a different service.
 *
 * ## Cost
 *
 * One `token_prices` PREFETCH for the whole batch, not one lookup per flow.
 *
 * Per-flow was the original shape, on the reasoning that a few hundred indexed
 * reads is cheap. Measured against production it was not: on the account with
 * real history, 537 sequential lookups were 51.2 of a 53.1-second `ytd`
 * request and 792 were 70.5 of 71.2 seconds over `all` — 96-99% of the whole
 * call, against 0.02s of arithmetic and 0.5s for the daily series (SC-471).
 * Sequential round-trips are the entire cost, so collapsing them into one
 * query is the entire fix.
 *
 * It is the same `PriceLookup` the nightly rollup uses, built by the same
 * `PriceGraphService.buildPriceLookup`, which is what answers the objection
 * this note used to carry — that a second, differently-warmed price path lets
 * a flow's value and the same transaction's cost basis disagree invisibly.
 * There is no second path: the index holds the rows the repository would have
 * returned, and a pair it was not built to cover falls through to the
 * repository rather than answering "no price" (`PriceLookup.covers`).
 */
@Service()
export class ExternalFlowService {
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly priceGraphService = Container.get(PriceGraphService);

  async forHoldings(
    holdings: readonly WeightedHolding[],
    baseCurrencyId: string,
    from: Date,
    to: Date
  ): Promise<ExternalFlowSeries> {
    if (holdings.length === 0) return { flows: [], unvaluedCount: 0, staleValuedCount: 0 };

    const weights = new Map(holdings.map((h) => [h.holdingId, h.weight]));
    const holdingIds = [...weights.keys()];
    const [transactions, holdingRows] = await Promise.all([
      this.txRepository.findForHoldingsInRange(holdingIds, from, to),
      this.holdingRepository.findByIds(holdingIds),
    ]);
    // Nothing crossed the boundary, so there is nothing to value and no
    // reason to pay for a prefetch. Most accounts in the product are here.
    if (transactions.length === 0) return { flows: [], unvaluedCount: 0, staleValuedCount: 0 };

    const heldTokenByHolding = new Map(holdingRows.map((row) => [row.id, row.tokenId]));

    // Every token a valuation below could ask to convert: the token each
    // holding holds, and — when the importer recorded an execution rate —
    // the token that rate is denominated in, which is routinely neither the
    // held token nor the base.
    const tokenIds = new Set<string>(heldTokenByHolding.values());
    for (const tx of transactions) {
      if (tx.tokenId) tokenIds.add(tx.tokenId);
      if (tx.priceNativeTokenId) tokenIds.add(tx.priceNativeTokenId);
    }
    const priceLookup = await this.priceGraphService.buildPriceLookup(tokenIds, baseCurrencyId, to);

    const flows: ExternalFlow[] = [];
    let unvaluedCount = 0;
    let staleValuedCount = 0;

    for (const tx of transactions) {
      if (flowRoleOf(tx.kind) === 'return') continue;
      const weight = weights.get(tx.holdingId);
      if (!weight) continue;

      const quantity = new Decimal(tx.quantity);
      if (quantity.isZero()) continue;

      const valuation = await this.valueOf(
        tx,
        quantity.abs(),
        baseCurrencyId,
        heldTokenByHolding,
        priceLookup
      );
      if (!valuation) unvaluedCount += 1;
      else if (valuation.stale) staleValuedCount += 1;

      // The ledger's own sign is the direction: negative quantity is value
      // leaving the holding. `valueTransactionInBase` works on magnitudes, so
      // the sign is re-applied here and nowhere else.
      const magnitude = valuation ? valuation.amount : new Decimal(0);
      const signed = quantity.isNegative() ? magnitude.negated() : magnitude;

      flows.push({
        transactionId: tx.id,
        holdingId: tx.holdingId,
        kind: tx.kind,
        occurredAt: tx.occurredAt,
        tokenId: tx.tokenId,
        quantity: tx.quantity,
        baseAmount: signed.mul(weight).toString(),
        valuationBasis: valuation ? valuation.basis : null,
        stale: valuation ? valuation.stale : false,
        weight: weight.toString(),
      });
    }

    return { flows, unvaluedCount, staleValuedCount };
  }

  private async valueOf(
    tx: HoldingTransaction,
    qtyAbs: Decimal,
    baseCurrencyId: string,
    heldTokenByHolding: ReadonlyMap<string, string>,
    priceLookup: PriceLookup
  ) {
    // `holding_transactions.token_id` is documented as kept in sync with the
    // holding's token, and the holding row is the authority when a bad
    // ingester lets the two drift. Fall back to the row's own token rather
    // than refusing to value it.
    const heldTokenId = heldTokenByHolding.get(tx.holdingId) ?? tx.tokenId ?? null;
    return valueTransactionInBase(
      this.priceGraphService,
      tx,
      qtyAbs,
      baseCurrencyId,
      heldTokenId,
      priceLookup
    );
  }
}

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
