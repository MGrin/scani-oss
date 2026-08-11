import { Decimal } from '@scani/shared';

// Mirrors `payment_occurrences.status` / `payments.direction` without
// importing `@scani/db/schema` — same rationale as `./recurrence.ts`:
// this module has no DB dependency, so it's callable from a job
// processor, a use case, or a test with a plain object.
export type OccurrenceMatchStatus = 'scheduled' | 'matched' | 'missed' | 'skipped';
export type PaymentMatchDirection = 'outflow' | 'inflow';

// The subset of a `payment_occurrences` row (joined with its parent
// `payments` row for `direction`/`vendorId`/`accountId`) that scoring
// needs. Callers assemble this from a join; this module never does one.
export interface OccurrenceToMatch {
  dueDate: Date;
  expectedAmount: string | null;
  direction: PaymentMatchDirection;
  vendorId: string;
  accountId: string | null;
  status: OccurrenceMatchStatus;
  matchedTransactionId: string | null;
}

// A candidate `holding_transactions` row, pre-resolved by the caller:
// `amount` is the signed Decimal string (negative = outflow, positive =
// inflow — the same convention `holding_transactions.quantity` uses),
// and `vendorId` is whatever `VendorRepository.findByAlias` resolved the
// raw `counterparty` string to (null if unresolved, or if the
// transaction never carried a counterparty at all — asset-centric
// sources like chain swaps legitimately never do).
export interface MatchCandidate {
  transactionId: string;
  amount: string;
  occurredAt: Date;
  accountId: string | null;
  vendorId: string | null;
}

export interface MatchOccurrenceOptions {
  // Absolute currency-unit floor, and a ratio of `expectedAmount` on top
  // — whichever is larger applies. A flat tolerance alone is too tight
  // for a $3,000 rent payment and too loose for a $3 subscription.
  amountToleranceFloor?: string;
  amountToleranceRatio?: string;
  dateWindowDays?: number;
  minScore?: number;
}

export interface MatchResult {
  transactionId: string;
  score: number;
}

const DEFAULT_AMOUNT_TOLERANCE_FLOOR = '0.50';
const DEFAULT_AMOUNT_TOLERANCE_RATIO = '0.02';
const DEFAULT_DATE_WINDOW_DAYS = 3;
// Auto-match threshold. Deliberately high: a false auto-match silently
// marks an unpaid bill as paid, which is strictly worse than surfacing
// nothing — the user stops looking. See the module doc below for how
// the weights are chosen so a genuinely exact match clears this
// comfortably while a merely-plausible one doesn't.
const DEFAULT_MIN_SCORE = 0.9;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Score components decay from 1.0 at zero delta down to this floor at
// the tolerance/window boundary — never to 0. "Exact" and "within
// tolerance" both clear a well-chosen threshold; they just don't tie.
const DECAY_FLOOR = 0.95;
// Two candidates within this of each other in score are a tie — surface
// to the human instead of guessing between them.
const TIE_EPSILON = 1e-9;

const AMOUNT_WEIGHT = 0.5;
const DATE_WEIGHT = 0.3;
const ACCOUNT_WEIGHT = 0.1;
const VENDOR_WEIGHT = 0.1;

function candidateDirection(amount: Decimal): PaymentMatchDirection {
  return amount.isNegative() ? 'outflow' : 'inflow';
}

// Linear decay from 1.0 (delta = 0) to `DECAY_FLOOR` (delta = limit).
// Returns null when `delta` exceeds `limit` — the hard "outside
// tolerance/window" reject, not just a low score.
function decayScore(delta: Decimal, limit: Decimal): number | null {
  if (delta.gt(limit)) return null;
  if (limit.isZero()) return 1;
  const fraction = delta.div(limit).toNumber();
  return 1 - fraction * (1 - DECAY_FLOOR);
}

function resolveAmountTolerance(
  expectedAmount: string | null,
  opts: MatchOccurrenceOptions
): Decimal {
  const floor = new Decimal(opts.amountToleranceFloor ?? DEFAULT_AMOUNT_TOLERANCE_FLOOR);
  if (expectedAmount === null) return floor;
  const ratio = new Decimal(opts.amountToleranceRatio ?? DEFAULT_AMOUNT_TOLERANCE_RATIO);
  const ratioAmount = new Decimal(expectedAmount).abs().times(ratio);
  return Decimal.max(floor, ratioAmount);
}

// Known-vs-known equality contributes full credit, a genuine mismatch
// (both known, different) costs the candidate the whole dimension — that
// is what lets a known-wrong account/vendor pull an otherwise-good
// amount+date match back below the auto-match threshold. Unknown on
// either side (no counterparty resolved, no account tied) is near-full
// credit rather than a hard 1 or 0: it must not itself block a match
// (amount+date alone can still clear the threshold), but a confirmed hit
// still has to outscore "we don't know" so it can break a tie the way
// the vendor-alias signal is meant to.
const UNKNOWN_DIMENSION_CREDIT = 0.9;

function dimensionScore(expected: string | null, actual: string | null): number {
  if (expected === null || actual === null) return UNKNOWN_DIMENSION_CREDIT;
  return expected === actual ? 1 : 0;
}

/**
 * Score a single occurrence against a set of candidate transactions and
 * return the best auto-match, or null when nothing clears the bar.
 *
 * Conservative by construction:
 *   - Direction mismatch (an inflow candidate for an outflow occurrence,
 *     or vice versa) is filtered out before scoring — it never matches,
 *     regardless of how close the amount/date are.
 *   - Amount and date deltas outside their tolerance/window are hard
 *     rejects, not low scores.
 *   - The best and second-best candidate tying (within `TIE_EPSILON`)
 *     returns null instead of picking one — ambiguity surfaces to the
 *     user rather than being silently resolved by score-ordering noise.
 *   - An already-`matched` occurrence short-circuits to its existing
 *     `matchedTransactionId` without re-scoring, so re-running this
 *     over the same occurrence with a different (even higher-scoring)
 *     candidate set never flips a confirmed match. `missed` / `skipped`
 *     occurrences were resolved by a human (or a missed-marking job);
 *     auto-matching would overwrite that decision, so they return null.
 */
export function matchOccurrence(
  occurrence: OccurrenceToMatch,
  candidates: MatchCandidate[],
  opts: MatchOccurrenceOptions = {}
): MatchResult | null {
  if (occurrence.status === 'matched') {
    return occurrence.matchedTransactionId
      ? { transactionId: occurrence.matchedTransactionId, score: 1 }
      : null;
  }
  if (occurrence.status !== 'scheduled') {
    return null;
  }

  const dateWindowDays = new Decimal(opts.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS);
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const amountTolerance = resolveAmountTolerance(occurrence.expectedAmount, opts);
  const expectedAmount =
    occurrence.expectedAmount === null ? null : new Decimal(occurrence.expectedAmount).abs();

  const scored: MatchResult[] = [];

  for (const candidate of candidates) {
    const candidateAmount = new Decimal(candidate.amount);
    if (candidateDirection(candidateAmount) !== occurrence.direction) continue;

    const dateDeltaDays = new Decimal(
      Math.abs(candidate.occurredAt.getTime() - occurrence.dueDate.getTime())
    ).div(MS_PER_DAY);
    const dateScore = decayScore(dateDeltaDays, dateWindowDays);
    if (dateScore === null) continue;

    let amountScore = 1;
    if (expectedAmount !== null) {
      const amountDelta = candidateAmount.abs().sub(expectedAmount).abs();
      const score = decayScore(amountDelta, amountTolerance);
      if (score === null) continue;
      amountScore = score;
    }

    const accountScore = dimensionScore(occurrence.accountId, candidate.accountId);
    const vendorScore = dimensionScore(occurrence.vendorId, candidate.vendorId);

    const score =
      AMOUNT_WEIGHT * amountScore +
      DATE_WEIGHT * dateScore +
      ACCOUNT_WEIGHT * accountScore +
      VENDOR_WEIGHT * vendorScore;

    scored.push({ transactionId: candidate.transactionId, score });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);

  const [best, second] = scored;
  if (!best || best.score < minScore) return null;
  if (second && Math.abs(second.score - best.score) < TIE_EPSILON) return null;
  return best;
}
