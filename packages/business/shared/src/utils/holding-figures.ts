import type { HoldingWithDetails } from '../dtos/holding';

/**
 * The figures the Holdings screen states about a portfolio: what counts toward
 * the total, the total itself, the debt inside it, the split by asset type and
 * each position's unrealised gain. Shared so the app and the MCP tools
 * (SC-1616) state the same numbers by running the same code, rather than by
 * two implementations agreeing.
 */

/** Kept aligned with `packages/core/src/config/tokens.ts`. */
const SCAM_PROBABILITY_THRESHOLD = 0.35;

/**
 * Does this token's `isScamProbability` count as scam?
 *
 * NOT `isScamFlagged`, which asks a different question of a different row.
 * That one reads `hiddenReason` off `holdings.getHidden` — the server's record
 * that *this holding* was hidden for being a scam. This one is the score, and
 * it is what a surface holding a plain token uses to decide whether the row is
 * badged or subtracted from a total.
 */
export function isScamToken(probability: number | null | undefined): boolean {
  return typeof probability === 'number' && probability >= SCAM_PROBABILITY_THRESHOLD;
}

export interface HoldingGainLoss {
  absolute: number;
  /** Percent of the cost basis, not a fraction. */
  percent: number;
}

/**
 * Unrealized P/L, or `null` when there is nothing to compare against — no
 * cost basis recorded, or no resolvable price for the position today.
 */
export function holdingGainLoss(
  holding: Pick<HoldingWithDetails, 'value' | 'costBasis'> & {
    token?: Pick<HoldingWithDetails['token'], 'typeCode' | 'symbol'>;
  },
  currency: string
): HoldingGainLoss | null {
  const { value, costBasis } = holding;
  // Cash in the base currency is 1 against itself, so no gain is possible.
  // Its stored cost basis is not evidence either way: before the rollup has
  // run the server falls back to the value, after it a holding with no
  // transactions has no lots and reads 0 (SC-1505).
  if (holding.token && isBaseCurrencyHolding({ token: holding.token }, currency)) {
    return typeof value === 'number' ? { absolute: 0, percent: 0 } : null;
  }
  if (typeof value !== 'number' || typeof costBasis !== 'number') return null;
  if (!(costBasis > 0)) return null;
  const absolute = value - costBasis;
  return { absolute, percent: (absolute / costBasis) * 100 };
}

/** Whether this holding is cash in the currency every figure is shown in. */
export function isBaseCurrencyHolding(
  holding: { token: Pick<HoldingWithDetails['token'], 'typeCode' | 'symbol'> },
  currency: string
): boolean {
  return holding.token.typeCode === 'fiat' && holding.token.symbol === currency;
}

/**
 * Whether a holding contributes to a total drawn over this list.
 *
 * The same three conditions the server applies in `isIncludedInTotal`
 * (`packages/business/domain/src/lib/holding-inclusion.ts`) — hidden, inactive
 * and scam-flagged holdings never count — restated on the client because the
 * v3 list totals the *filtered* rows and so cannot use the server's own
 * `summary.totalValue`, which is always over the whole portfolio.
 *
 * SC-63 is what the missing `isActive` half cost: deactivating one position
 * left `/holdings` reading €599,511.02 while `/`, `/accounts` and
 * `/institutions` all read €525,728.45 — two screens disagreeing by 14% of net
 * worth over one data set, and surviving a hard reload, so not even a cache to
 * blame. The server was right; this list was the one arithmetic nobody had
 * taught the rule to.
 *
 * The row itself stays on the list, badged `Inactive`. Excluding it outright
 * would be the easier fix and the wrong one: deactivating is one tap, so a
 * holding deactivated by accident has to still be findable to be turned back
 * on. It is subtracted from the figure, not from the surface.
 */
export function countsTowardTotal(
  holding: Pick<HoldingWithDetails, 'isActive' | 'isHidden' | 'token'>
): boolean {
  if (holding.isHidden) return false;
  if (!holding.isActive) return false;
  return !isScamToken(holding.token.isScamProbability);
}

/**
 * The value of a set of holdings.
 *
 * Unpriceable positions contribute nothing rather than making the whole sum
 * unknown — the same choice `holdings.getWithDetails` makes for its summary.
 * The list beneath shows each of them as `—`, so the omission is visible on
 * the same screen as the total.
 */
export function holdingsValue(holdings: readonly HoldingWithDetails[]): number {
  return holdings.reduce(
    (sum, holding) => (countsTowardTotal(holding) ? sum + (holding.value ?? 0) : sum),
    0
  );
}

/**
 * Margin debt among the rows that count: the sum of their negative values
 * (SC-1463). `holdingsValue` already nets it and `holdingAllocation` leaves it
 * out, so this is the line that reconciles the bar with the figure.
 */
export function holdingsDebt(holdings: readonly HoldingWithDetails[]): number {
  return holdings.reduce(
    (sum, holding) =>
      countsTowardTotal(holding) && (holding.value ?? 0) < 0 ? sum + (holding.value ?? 0) : sum,
    0
  );
}

/**
 * Positive value per asset type over the rows that count, biggest first: the
 * Holdings screen's allocation bar before it is labelled.
 */
export function holdingTypeTotals(
  holdings: readonly HoldingWithDetails[]
): { typeCode: string; type: string; value: number }[] {
  const byType = new Map<string, { typeCode: string; type: string; value: number }>();
  for (const holding of holdings) {
    if (!countsTowardTotal(holding)) continue;
    if (typeof holding.value !== 'number' || holding.value <= 0) continue;
    const key = holding.token.typeCode;
    const existing = byType.get(key);
    if (existing) existing.value += holding.value;
    else byType.set(key, { typeCode: key, type: holding.token.type, value: holding.value });
  }
  return [...byType.values()].sort((a, b) => b.value - a.value);
}
