import type { HoldingTransaction } from '@scani/db/schema';
import type { ValuationBasisDto } from '@scani/shared';
import Decimal from 'decimal.js';
import type { PriceGraphService } from '../services/pricing/PriceGraphService';
import type { PriceLookup } from '../services/pricing/PriceLookup';

/**
 * What one ledger row is worth in the user's base currency at the instant it
 * happened — the single implementation, shared by cost basis and by returns.
 *
 * Lifted out of `CostBasisService` unchanged when SC-457 needed the same
 * answer for external flows. Two copies would have been two answers: a
 * contribution valued one way and the cost basis of the very same
 * transaction valued another produces a return figure that cannot be
 * reconciled with the gain shown beside it, and nothing on either screen
 * would say why.
 *
 * Two routes, and the caller is told which one answered:
 *
 *   1. `execution_rate` — the importer recorded `priceNative`, so
 *      `qty x priceNative` in `priceNativeTokenId`, converted to base. For a
 *      trade or a swap this is the rate the deal actually executed at and
 *      needs no price source at all.
 *   2. `held_token` — the quantity in the HELD token, converted to base via
 *      the price graph at `occurredAt`. This is what values a fiat deposit
 *      (a EUR balance worth EUR 500 at receipt) and any leg whose worth can
 *      be inferred from spot.
 *
 * `null` only when neither resolves. The `stale` flag travels with the amount
 * rather than being dropped, because a leg valued from a 96-day-old quote is
 * otherwise indistinguishable from one priced on the day (SC-151).
 */
export type ValuationBasis = ValuationBasisDto;

export interface TxValuation {
  amount: Decimal;
  stale: boolean;
  basis: ValuationBasis;
}

/** The subset of a ledger row this valuation reads. */
export type ValuableTransaction = Pick<
  HoldingTransaction,
  'priceNative' | 'priceNativeTokenId' | 'occurredAt'
>;

export async function valueTransactionInBase(
  priceGraphService: PriceGraphService,
  tx: ValuableTransaction,
  qtyAbs: Decimal,
  baseCurrencyId: string,
  heldTokenId: string | null,
  priceLookup?: PriceLookup
): Promise<TxValuation | null> {
  const convertOpts = priceLookup
    ? ({ preferGranularity: 'daily', priceLookup } as const)
    : ({ preferGranularity: 'daily' } as const);

  if (tx.priceNative && tx.priceNativeTokenId) {
    const native = new Decimal(tx.priceNative).mul(qtyAbs);
    // Recorded by the importer at the moment of the trade — no price
    // lookup, so nothing to be stale.
    if (tx.priceNativeTokenId === baseCurrencyId) {
      return { amount: native, stale: false, basis: 'execution_rate' };
    }
    const converted = await priceGraphService.convert(
      native,
      tx.priceNativeTokenId,
      baseCurrencyId,
      tx.occurredAt,
      convertOpts
    );
    if (converted) {
      return { amount: converted.amount, stale: converted.stale, basis: 'execution_rate' };
    }
    // priceNative recorded but no FX route: continue to the held-token
    // fallback below rather than returning null.
  }

  if (heldTokenId) {
    if (heldTokenId === baseCurrencyId) {
      return { amount: qtyAbs, stale: false, basis: 'held_token' };
    }
    const converted = await priceGraphService.convert(
      qtyAbs,
      heldTokenId,
      baseCurrencyId,
      tx.occurredAt,
      convertOpts
    );
    if (converted) {
      return { amount: converted.amount, stale: converted.stale, basis: 'held_token' };
    }
  }

  return null;
}
