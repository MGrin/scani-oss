import type { HoldingTransaction } from '@scani/db/schema';

/**
 * The loads one user's return windows have in common, held while that user's
 * data is unchanged (SC-1671). Home asks for `all`, `1y` and `ytd` in one batch,
 * and each window read every holding's evidence for its drift rows and resolved
 * every holding's currency: three times the same rows, decoded on the API's
 * one event loop, which held it for 6 s on production.
 *
 * Neither load depends on the window. A caller hands one instance to every
 * window it computes over the same data, and drops it when the data changes.
 */
export class ReturnsSharedLoads {
  /** Drift rows by holding, `null` where a holding has none. */
  readonly driftByHolding = new Map<string, Promise<HoldingTransaction[] | null>>();
  /** `holdingId -> currency token id`, by the sorted holding ids asked about. */
  readonly currencyByHoldings = new Map<string, Promise<Map<string, string | null>>>();
}
