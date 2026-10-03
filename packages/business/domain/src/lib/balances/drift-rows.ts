import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { unexplainedDrift } from './unexplained-drift';

/**
 * A balance change no ledger row explains, as rows the money side can read
 * (SC-1470).
 *
 * mgrin, 2026-10-01, deciding against SC-501's rule knowingly: an unexplained
 * change is money in or out, never gain. Unanswered and `unknown` gaps become
 * `drift_in` / `drift_out`, which `flowRoleOf` classifies as external; a gap
 * the owner answered `growth` becomes `drift_growth`, which is return, because
 * he said it was. `flow` and `correction` answers write their own ledger rows,
 * so whatever drift survives them is unexplained again and treated as above.
 *
 * The rows follow `BalanceAtTimeService.driftAhead` exactly: that spreads the
 * drift linearly between the two readings, and the value series is read at
 * day ends, so the drift is cut at every day end inside the gap and the last
 * piece lands on the later reading. Cut anywhere else, a window ending inside
 * a gap would hold value the flows never paid for.
 *
 * These rows are never written. They are for readers of money (flows, cost
 * basis, income) only: the balance walk already carries the same drift, and
 * handing it these too would count it twice.
 */
export const DRIFT_IN_KIND = 'drift_in';
export const DRIFT_OUT_KIND = 'drift_out';
export const DRIFT_GROWTH_KIND = 'drift_growth';

const GROWTH_ANSWER = 'growth';

export interface DriftRow {
  id: string;
  holdingId: string;
  tokenId: string;
  kind: typeof DRIFT_IN_KIND | typeof DRIFT_OUT_KIND | typeof DRIFT_GROWTH_KIND;
  quantity: string;
  occurredAt: Date;
}

interface Reading {
  observedAt: Date;
  balance: string;
  gapReview: string | null;
}

interface LedgerRow {
  occurredAt: Date;
  quantity: string;
}

/**
 * The opening counts as well as the gaps (SC-1470). A holding is valued from
 * its first record, a ledger row or a reading, and what it held then is
 * whatever its first reading says less what the ledger explains up to that
 * reading. That unexplained opening is money in, booked just before the first
 * record and never before that record's own day: flows are counted by day, so
 * the money side sees it on the day the value series first counts the holding,
 * and the cost walk meets it before any row that draws on it. A holding whose
 * ledger explains its first reading opens with nothing.
 */
export function driftRows(
  holding: { holdingId: string; tokenId: string },
  readings: ReadonlyArray<Reading>,
  ledger: ReadonlyArray<LedgerRow>
): DriftRow[] {
  const ordered = [...readings].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const rows: DriftRow[] = [];
  const push = (kind: DriftRow['kind'], quantity: Decimal, at: Date) =>
    rows.push({
      id: `drift:${holding.holdingId}:${rows.length}`,
      holdingId: holding.holdingId,
      tokenId: holding.tokenId,
      kind,
      quantity: quantity.toString(),
      occurredAt: at,
    });
  const first = ordered[0];
  if (first) {
    const upTo = first.observedAt.getTime();
    const explained = ledger.filter((t) => t.occurredAt.getTime() <= upTo);
    const opening = unexplainedDrift(
      '0',
      first.balance,
      explained.map((t) => t.quantity)
    );
    if (!opening.isZero()) {
      const earliest = Math.min(upTo, ...explained.map((t) => t.occurredAt.getTime()));
      const at = Math.max(earliest - 1, Math.floor(earliest / DAY_MS) * DAY_MS);
      push(opening.isNegative() ? DRIFT_OUT_KIND : DRIFT_IN_KIND, opening, new Date(at));
    }
  }
  for (let i = 1; i < ordered.length; i += 1) {
    const before = ordered[i - 1] as Reading;
    const after = ordered[i] as Reading;
    const lo = before.observedAt.getTime();
    const hi = after.observedAt.getTime();
    if (hi <= lo) continue;
    const bridge = ledger
      .filter((t) => t.occurredAt.getTime() > lo && t.occurredAt.getTime() <= hi)
      .map((t) => t.quantity);
    const drift = unexplainedDrift(before.balance, after.balance, bridge);
    if (drift.isZero()) continue;
    const kind =
      after.gapReview === GROWTH_ANSWER
        ? DRIFT_GROWTH_KIND
        : drift.isNegative()
          ? DRIFT_OUT_KIND
          : DRIFT_IN_KIND;
    const cuts = dayEndsBetween(lo, hi);
    cuts.push(hi);
    let previous = lo;
    let booked = new Decimal(0);
    for (const [index, cut] of cuts.entries()) {
      const piece =
        index === cuts.length - 1
          ? drift.sub(booked)
          : drift
              .mul(cut - previous)
              .div(hi - lo)
              .toDecimalPlaces(PIECE_PLACES);
      booked = booked.add(piece);
      previous = cut;
      if (!piece.isZero()) push(kind, piece, new Date(cut));
    }
  }
  return rows;
}

/** The rows in the ledger's own shape, for readers that walk ledger rows. */
export function asLedgerRows(rows: ReadonlyArray<DriftRow>, userId: string): HoldingTransaction[] {
  return rows.map(
    (row) =>
      ({
        id: row.id,
        userId,
        holdingId: row.holdingId,
        tokenId: row.tokenId,
        kind: row.kind,
        quantity: row.quantity,
        priceNative: null,
        priceNativeTokenId: null,
        counterTokenId: null,
        counterQuantity: null,
        counterPriceNative: null,
        counterPriceNativeTokenId: null,
        feeQuantity: null,
        feeTokenId: null,
        occurredAt: row.occurredAt,
        externalId: row.id,
        swapGroupId: null,
        transferGroupId: null,
        transferReview: null,
        transferReviewSplit: null,
        transferReviewedAt: null,
        transferReviewSource: null,
        transferReviewRuleId: null,
        settlesTransactionId: null,
        counterparty: null,
        description: null,
        source: 'drift',
        sourceMetadata: {},
        rawPayload: null,
        createdAt: row.occurredAt,
        updatedAt: row.occurredAt,
      }) as HoldingTransaction
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Short enough that the pieces of a drift add back to it exactly at
// decimal.js's 20 significant digits; the last piece takes the remainder.
const PIECE_PLACES = 12;

/** Every `T23:59:59.999Z` strictly between `lo` and `hi`. */
function dayEndsBetween(lo: number, hi: number): number[] {
  const out: number[] = [];
  let end = Math.floor(lo / DAY_MS) * DAY_MS + DAY_MS - 1;
  if (end <= lo) end += DAY_MS;
  for (; end < hi; end += DAY_MS) out.push(end);
  return out;
}
