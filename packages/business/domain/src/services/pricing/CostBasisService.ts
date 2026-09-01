import type { DatabaseTransaction } from '@scani/db';
import type { HoldingTransaction } from '@scani/db/schema';
import {
  answerIsOwedFor,
  answerSourceOf,
  type DisposalAnswerSourceDto,
  isLinkingDecision,
  TRANSFER_REVIEW_FEE,
  TRANSFER_REVIEW_SPLIT,
  type TransferReviewSplit,
  transferReviewSplitSchema,
} from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { sortLedgerEvents } from '../../lib/ledger-order';
import {
  type CostBasisMethod,
  DEFAULT_COST_BASIS_METHOD,
  EMPTY_SECTION_104_PLAN,
  type PlanAcquisition,
  type PlanDisposal,
  planSection104Matches,
  poolDrawFor,
  type Section104Plan,
} from '../../lib/lot-matching';
import {
  type TxValuation,
  type ValuationBasis,
  valueTransactionInBase,
} from '../../lib/tx-valuation';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { PriceGraphService } from './PriceGraphService';
import type { PriceLookup } from './PriceLookup';

// FIFO lot tracking state. `cost` is the per-unit cost summed across
// the lot's `qty`, denominated in the user's base currency at
// transaction time. `date` is the lot's acquisition date (preserved
// for first-in-first-out ordering and downstream lot-detail queries).
export interface CostLot {
  qty: Decimal;
  cost: Decimal;
  date: Date;
  /**
   * The price this lot's cost came from was outside the staleness window on
   * the acquisition date (SC-151), or nothing could value the inflow at all
   * and the cost below is a zero standing in for an unknown (SC-149).
   *
   * The walk already folds both into a holding-wide `Doubt`. They are carried
   * on the lot as well so a *disposal* can be graded by the lots it actually
   * consumed rather than by everything that ever happened to the holding: a
   * sale of a lot bought yesterday at a known price is a settled figure even
   * when some other lot on the same holding was priced from a six-week-old
   * quote. Neither flag affects any arithmetic.
   */
  stale?: boolean;
  unpriced?: boolean;
}

// Internal lot for the transfer-aware component walk — a CostLot that
// also tracks which holding it currently resides in, so a transfer can
// move it between holdings on the shared ledger.
interface ComponentLot extends CostLot {
  holdingId: string;
}

/**
 * How much of a holding's cost we actually know (SC-149, SC-151).
 *
 * The walk always produces *a* number. Before this existed, that number
 * was indistinguishable from a confident one — a Kraken import truncated
 * at 20,000 ledger rows and a holding genuinely bought at zero cost both
 * emerged as `costBasis: 0`, and the missing acquisitions turned the whole
 * disposal into gain. The error only ever ran one way, upward, which is
 * what made it read as good news.
 *
 *   - `known`    — complete history, every cost-relevant leg priced from a
 *                  quote inside the freshness window.
 *   - `partial`  — a number, but derived from something we know is missing
 *                  or old: a provider that reported truncation, a leg priced
 *                  beyond the staleness cap, or an inflow booked at zero cost
 *                  because nothing could value it.
 *   - `unknown`  — no cost-relevant transaction at all before `at`. There is
 *                  no cost to report, only the absence of one.
 */
export type CostBasisQuality = 'known' | 'partial' | 'unknown';

export interface CostBasisAtTime {
  openQty: Decimal;
  costBasis: Decimal; // sum of remaining lots' cost in base currency
  realizedPnl: Decimal; // cumulative realized PnL up to `at`
  lots: CostLot[]; // remaining open lots, oldest first
  // False when the holding has no cost-relevant transaction at or before
  // `at`. The walk then produces costBasis 0, which would render the
  // whole position as unrealized gain. Callers (PnLAtTimeService) treat
  // a cost-unknown holding as cost basis = current value (0% gain).
  hasTransactions: boolean;
  // See CostBasisQuality. Callers must not present a non-`known` basis
  // as a settled figure — PnLAtTimeService counts them into
  // `holdingsBasisUnknown`, which reaches the chart, the PnL series and
  // both exports.
  basisQuality: CostBasisQuality;
  // Outflows at or before `at` whose lots left with no gain booked because
  // nobody has answered them yet (SC-160). Exactly the rows the review
  // queue holds — see `countsAsUnreviewed`. `realizedPnl` above understates
  // by whatever the genuine disposals among them were worth, so no surface
  // may present it as complete while this is above zero.
  transfersUnreviewed: number;
}

/**
 * What the caller knows about a holding's transaction history, from
 * `holding_coverage.has_complete_tx_history`.
 *
 * Three states, not two, because an *absent* coverage row is not the same
 * claim as a `false` one. A `false` is written deliberately — Kraken when
 * its ledger pages out at the row cap or contradicts its own running
 * balance, the EVM base when a stream's pagination stopped before the
 * chain head, `TransactionRouter` for any incremental `since` run — and
 * that is the signal this ticket is about.
 *
 * The first two of those reach the flag through `retractHistoryClaim`
 * (SC-395). Before it existed neither provider could say anything: Kraken
 * computed the verdict into a discarded generator value, and the EVM
 * base's own header claimed a gate that was not in the file. Roughly a fifth of production holdings have no coverage row at
 * all (manual entries, older file imports); treating those as incomplete
 * would flag more holdings than the deliberate `false` does and drown the
 * signal in its own noise. So only an explicit `false` degrades the basis.
 */
export type HistoryCompleteness = 'complete' | 'incomplete' | 'unrecorded';

export function historyCompletenessOf(
  coverage: { hasCompleteTxHistory: boolean } | null | undefined
): HistoryCompleteness {
  if (!coverage) return 'unrecorded';
  return coverage.hasCompleteTxHistory ? 'complete' : 'incomplete';
}

/**
 * What the walk did with one outflow, and therefore why realized PnL moved —
 * or did not (SC-152).
 *
 * `realizedPnl` is a scalar, so "why did my realized gain change?" has no
 * answer today: there is a number and nothing behind it. Since SC-150 the
 * harder half of the question is the *absence* of a change — an outflow can
 * leave a holding, pop its lots and book nothing at all, and four different
 * situations look identical from outside. This names which one happened.
 *
 * - `realized` — proceeds were known and the gain is in the scalar. The only
 *   outcome whose `gain` is non-null, and the only one that sums into it.
 * - `unpriced` — nothing could value it: NEITHER the recorded execution rate
 *   nor the token in hand converts to base at `occurredAt`. Lots popped,
 *   nothing booked, because booking zero proceeds would realize a phantom
 *   loss of the whole basis. Until SC-397 this was reached far more often
 *   than that description implies — a swap refused the held-token route on
 *   principle, so an unpriceable *counter* asset was enough on its own.
 * - `unreviewed` — unlinked and unanswered. Sitting in the review queue, and
 *   the one outcome a person can clear (SC-160).
 * - `retained` — answered, and the answer was that it never left the user's
 *   control: a move to a cold wallet or an exchange we hold no key for. Not a
 *   disposal, and correctly books nothing.
 * - `awaiting_pair` — carries a `transfer_group_id` whose other leg is not in
 *   this walk. Usually an import that fetched one side; at a snapshot date
 *   before the inflow occurred it is also simply correct, and it resolves
 *   itself the day the pair completes. Deliberately not `unreviewed`: the
 *   queue does not hold it, so there is nothing for a reader to go and answer.
 */
export type DisposalOutcome =
  | 'realized'
  | 'unpriced'
  | 'unreviewed'
  | 'retained'
  | 'awaiting_pair'
  | 'fee';

/**
 * Which of `txValueInBase`'s two routes produced a row's figure (SC-397).
 *
 * - `execution_rate` — the rate the trade executed at, recorded by the
 *   importer as `priceNative` and denominated in the counter token. Exact,
 *   from the venue or the chain, and preferred wherever it converts to base.
 * - `held_token` — the token in hand, priced at spot on the day. The only
 *   route available to a fiat deposit or an unlinked transfer, and the one a
 *   swap falls back to when its counter asset has no price history.
 *
 * It exists because the fallback is *silent* otherwise, and this ticket is
 * about a silent number: before SC-397 a swap whose counter could not be
 * converted booked 0.00, which reads exactly like a disposal that earned
 * nothing. Valuing it from the held token is right — for a linked swap it is
 * the partner leg's own valuation reached from the other end — but a reader
 * comparing our figure against an exchange statement needs to know which
 * price answered, because the two disagree by up to 2.44% in this ledger.
 */
/**
 * Which identification rule this walk applies (SC-462). See
 * `lib/lot-matching.ts` — the walk is otherwise regime-independent.
 */
export type { CostBasisMethod, ValuationBasis };

/**
 * Whose answer a disposal's outcome rests on (SC-324). It IS
 * `DISPOSAL_ANSWER_SOURCES` from `@scani/shared`, where the reasoning lives —
 * aliased rather than restated, because it used to be a hand-written copy of the
 * same union and a third source landed in one of them (SC-350).
 *
 * `outcome` above says what the walk did; this says on whose authority it did
 * it. `realized` on a withdrawal is produced by `transfer_review =
 * 'left_control'` alone, and that column holds an answer a person gave and a
 * value something wrote in the same three words.
 */
export type DisposalAnswerSource = DisposalAnswerSourceDto;

/**
 * One outflow matched against one acquisition lot (SC-152).
 *
 * **Granularity is one row per (outflow, lot) pair, not per outflow.** A sale
 * that consumes three lots bought on three dates has three acquisition dates
 * and three holding periods, and no single date describes it — so the row that
 * explains the gain is the match, not the transaction. `proceeds` is split
 * across the matched lots pro-rata by quantity, which is what makes the rows
 * sum back to the scalar exactly rather than approximately.
 *
 * This is not a tax record and must not be presented as one: the ledger
 * underneath is not tax-grade, for eleven separate reasons set out in
 * `docs/technical/2026-08-14_why-no-tax-statement.md`. What it is is the same
 * arithmetic the app already shows, with its working kept.
 */
export interface DisposalLotMatch {
  transactionId: string;
  holdingId: string;
  tokenId: string;
  /** `sell` | `swap_out` | `withdraw` | `transfer_out`, raw. Not collapsed to
   *  "sold": whether a withdrawal is a disposal is a *question we asked the
   *  user* (SC-150), and a row that hides that behind one verb asserts a sale
   *  nobody stated. Read it with `outcome`, which says what actually happened. */
  kind: string;
  disposedAt: Date;
  /** Null on the portion of an outflow that found no acquisition lot left —
   *  the history is short, and the row says so rather than reporting those
   *  proceeds as pure gain without comment. */
  acquiredAt: Date | null;
  quantity: Decimal;
  /** Base currency at the disposal's own date, or null when nothing was
   *  valued — either because no price route resolved, or because this outcome
   *  never asked for one. `outcome` distinguishes the two. */
  proceeds: Decimal | null;
  /** Base currency at the *acquisition's* date. Zero when `acquiredAt` is null. */
  costBasis: Decimal;
  /** `proceeds − costBasis`, or null when nothing was realized. Summing the
   *  non-null gains over a walk reproduces `realizedPnl` exactly — a test
   *  pins it, because that scalar is what the chart, `portfolio_value_daily`
   *  and both exports already show, and an explanation that disagrees with
   *  the figure it explains is worse than no explanation. */
  gain: Decimal | null;
  /** Calendar days between acquisition and disposal. Null when unmatched. */
  holdingDays: number | null;
  /**
   * Which share of its outflow this row belongs to, and how many there are
   * (SC-181). `0` / `1` on every unsplit row.
   *
   * The ledger groups on `transactionId` + `portionIndex` rather than
   * `transactionId` alone: an outflow answered as two things at once has two
   * outcomes, and a group carrying one `outcome` for both would be a row that
   * is true of neither half.
   */
  portionIndex: number;
  portionCount: number;
  /**
   * How much this row's own figures rest on (SC-149), graded exactly as a
   * holding's basis is: `unknown` when there was no acquisition to match at
   * all, `partial` when the holding's history is knowingly truncated or either
   * side of this row was priced beyond the freshness window, `known`
   * otherwise. A confident-looking gain derived from an import that stopped at
   * 20,000 rows is the failure this grade exists to make visible, and it has
   * to travel to wherever the lots are shown or the explanation misleads.
   */
  basisQuality: CostBasisQuality;
  outcome: DisposalOutcome;
  /**
   * Which price answered for `proceeds` (SC-397). Null when nothing did —
   * `outcome` says which flavour of nothing.
   *
   * `held_token` on a swap is the case worth reading: the swap's own
   * execution rate is denominated in a counter asset that has no price on the
   * day, so the leg is valued from the token that left instead. Before SC-397
   * that leg booked 0.00 and said nothing, and 0.00 is also what a disposal
   * that genuinely earned nothing books.
   */
  valuationBasis: ValuationBasis | null;
  /**
   * Whose answer this row's outcome rests on (SC-324).
   *
   * `basisQuality` grades how much of the *cost* side is known. This grades
   * the other input — the decision that made the row a disposal at all — and
   * it needs saying for the same reason: the figure is produced either way,
   * and nothing else on the row distinguishes an answer a person gave from a
   * value something wrote.
   */
  answerSource: DisposalAnswerSource;
}

// Transaction kinds that contribute INFLOW (add to lot pool).
const INFLOW_BUY_KINDS = new Set(['buy', 'swap_in']);
// Other inflow kinds — deposits, rewards, airdrops, transfers in,
// opening balances. Cost basis is the inflow's fair-market value at
// receipt: priceNative when the importer recorded one, otherwise
// the held token's spot price at occurredAt converted to base via
// PriceGraphService. This is what brokerages and tax software call
// "FMV at receipt" — for stocks-as-rewards or fiat deposits it
// produces a non-zero cost basis matching what the user effectively
// "paid" for the position. Only when no price reference exists at
// all do we fall back to a true zero-cost lot.
const INFLOW_OTHER_KINDS = new Set([
  'deposit',
  'reward',
  'interest',
  'airdrop',
  'transfer_in',
  'opening_balance',
]);
const OUTFLOW_SELL_KINDS = new Set(['sell', 'swap_out']);
/**
 * Does this outflow carry the answer that says it left the portfolio? (SC-150)
 *
 * Only `left_control` realizes. `untracked` is the user saying the asset is
 * still theirs in an account we cannot see — not a disposal. `paired` and
 * `internal` never reach these branches, because both write a
 * `transfer_group_id` and `walkComponent` carries the lots across instead.
 *
 * **It does not check that a person answered, and the name and this comment
 * used to say it did** (SC-324). The two are not the same question:
 * `transfer_review` is written by `TransferReviewService` with
 * `transfer_reviewed_at` beside it, and it has also been written by a raw
 * `UPDATE` that set neither. Measured in production on 2026-08-17: all but one
 * `left_control` row carries no timestamp, nearly all of them from one
 * transaction on 2026-08-14, and between them they account for more than the
 * whole of the realized total.
 *
 * Requiring the timestamp here is a one-line change that would un-realize all
 * of them at once and move that total by the full amount. Whether it *should*
 * is SC-302 — a question about what those rows are, which no query can settle
 * and which is not this function's to decide. So the predicate stays as it is,
 * deliberately, and the distinction it cannot make is carried to the reader
 * instead: every ledger row says whose answer it rests on
 * (`DisposalLotMatch.answerSource`).
 */
function isConfirmedDisposal(tx: HoldingTransaction): boolean {
  return tx.transferReview === 'left_control';
}

/**
 * Whose answer an outflow's outcome rests on — the same rule the review queue
 * applies (`TransferReviewService.listAnswered`), plus the state that queue
 * never has to name because it only lists answered rows (SC-324).
 *
 * "The same rule" is now literal rather than a claim: both call
 * `answerSourceOf` from `@scani/shared` (SC-350). It was two copies of one
 * fallback chain, and adding a third source to only one of them is how a ledger
 * row and the queue row it came from end up disagreeing about who decided.
 *
 * **The kind gate is the second half of "the same rule", and it was missing**
 * (SC-402). `listAnswered`, `pendingPredicate`, `ruleWritablePredicate` and
 * `bulkClassify` all restrict `kind` to the answerable outflows; this function
 * did not, and it is the only reader of `transfer_review` on the surface that
 * shows money. A `swap_out` realizes on its kind alone — `OUTFLOW_SELL_KINDS`
 * is tested before the neutral branch and the sell branch never reads the
 * answer — so a stale `left_control` left over from a re-import that changed
 * `kind` underneath it (`bulkUpsert` carries `kind`, deliberately not
 * `transfer_review`) did nothing to the books and one thing to the screen: it
 * stamped the disposal `unattributed`, and the ledger rendered an "Answer not
 * recorded" badge and *"Recorded as having left your portfolio, so this gain
 * was booked. There is no record of anyone answering it."*
 *
 * Both halves are false about a swap, so a swap gets `'none'` — which is not a
 * new state invented to hold it but the value the contract already describes
 * as "a sale or swap the importer recorded". The row then says nothing about
 * provenance, because there is nothing to say: no answer is owed and none is
 * missing.
 *
 * This is deliberately NOT a data repair. SC-338 cleared the six rows that
 * existed; what this stops is the next one, and the 19 swap legs SC-398's
 * import is waiting to add.
 */
function disposalAnswerSourceOf(tx: HoldingTransaction): DisposalAnswerSource {
  if (!answerIsOwedFor(tx.kind)) return 'none';
  if (tx.transferReview === null) return 'none';
  return answerSourceOf(tx);
}

/**
 * One share of an outflow and what the walk does with it (SC-181).
 *
 * Every neutral outflow used to be exactly one of three things. It is now a
 * *sequence* of shares, and an unsplit row is the sequence of length one — so
 * the two walks below gained a loop and lost no branch, and a row with no
 * split takes byte-for-byte the same path it took before.
 *
 * - `carry` — the lots move to a linked inflow. Needs `transfer_group_id`.
 * - `realize` — priced at market and booked, the `left_control` answer.
 * - `hold` — the lots leave and nothing is booked. `held` says which of the
 *   several situations that produce that identical arithmetic this one is.
 * - `fee` — a charge taken out of what left (SC-888). Books nothing, like
 *   `hold`, and is a fourth action rather than a `held` value because the two
 *   differ in where the share's COST goes: a `hold` share's lots are gone,
 *   while a fee's join the group's buffer when there is one, so `rehome` still
 *   lands the whole cost on the units that survive the move.
 */
interface OutflowPortion extends PortionRef {
  qty: Decimal;
  action: 'carry' | 'realize' | 'hold' | 'fee';
  held: DisposalOutcome;
}

/** Just the identity half, which is all the ledger needs. */
interface PortionRef {
  index: number;
  count: number;
}

/** What an unsplit outflow is: the whole of itself, once. */
const WHOLE_PORTION: PortionRef = { index: 0, count: 1 };

/**
 * Divide an outflow into the shares its answer describes.
 *
 * The reconciliation in the middle is the part worth reading. A split is
 * written only after being checked to sum exactly to the row's quantity, but
 * the row can change afterwards — a re-import correcting an amount rewrites
 * `quantity` and knows nothing about the answer attached to it. So the walk
 * treats the *transaction* as the authority on how much left and the split as
 * the authority on what happened to it: each portion takes at most what is
 * left, and any remainder becomes an `unreviewed` share.
 *
 * That keeps the invariant this walk cannot survive losing — the lots popped
 * for one transaction sum to its quantity, never more — while making drift
 * visible in the ledger as an unanswered part rather than repairing it
 * silently into a number nobody chose.
 */
function outflowPortions(tx: HoldingTransaction, qtyAbs: Decimal): OutflowPortion[] {
  const split = parseSplit(tx);
  if (split === null) {
    // The group id is still read FIRST — `transfer-review-queue.ts` and two
    // test files rest on that precedence, and a matcher-linked row carries its
    // lots whatever answer is stamped on it. `fee` sits between the link and
    // `isConfirmedDisposal` because the whole-row answer "this withdrawal WAS
    // the bank's charge" must never reach the `realize` branch (SC-888).
    const action: OutflowPortion['action'] =
      tx.transferGroupId !== null
        ? 'carry'
        : tx.transferReview === TRANSFER_REVIEW_FEE
          ? 'fee'
          : isConfirmedDisposal(tx)
            ? 'realize'
            : 'hold';
    return [{ index: 0, count: 1, qty: qtyAbs, action, held: skippedOutcome(tx) }];
  }

  const portions: OutflowPortion[] = [];
  let remaining = qtyAbs;
  for (const entry of split) {
    if (remaining.lte(0)) break;
    const want = new Decimal(entry.quantity).abs();
    const qty = Decimal.min(want, remaining);
    remaining = remaining.minus(qty);
    portions.push({
      index: portions.length,
      count: split.length,
      qty,
      // `internal` carries for exactly the reason `paired` does, and by
      // exactly the same mechanism (SC-187): both write one shared
      // `transfer_group_id`, and the inflow this walk inherits from is a real
      // `holding_transactions` row either way — found for `paired`, written by
      // `TransferReviewService.resolveSplit` for `internal`. Nothing else in
      // this file distinguishes them, and nothing should: a fourth branch here
      // would be a second way to spell "the lots move".
      action: isLinkingDecision(entry.decision)
        ? 'carry'
        : entry.decision === 'left_control'
          ? 'realize'
          : entry.decision === TRANSFER_REVIEW_FEE
            ? 'fee'
            : 'hold',
      // `untracked` — the user said this share is still theirs somewhere we
      // cannot see. Same sentence the ledger already has for a whole
      // `untracked` answer, because it is the same claim about less of it.
      //
      // A `fee` share overrides it below rather than here: `held` is what the
      // `hold` branch renders, and a fee is not held by anybody.
      held: entry.decision === TRANSFER_REVIEW_FEE ? 'fee' : 'retained',
    });
  }
  if (remaining.gt(0)) {
    portions.push({
      index: portions.length,
      count: portions.length + 1,
      qty: remaining,
      action: 'hold',
      held: 'unreviewed',
    });
  }
  // `count` is stamped after the fact so a reconciled remainder is counted as
  // the part it is — "part 3 of 3", not "part 3 of 2".
  const count = portions.length;
  return portions.map((p) => ({ ...p, count }));
}

/**
 * The stored split, or null when this row is answered whole.
 *
 * A `split` marker whose payload will not parse is not treated as `retained`:
 * that would book nothing and tell the reader they had said so. It falls back
 * to one unanswered share, which is what it is.
 */
function parseSplit(tx: HoldingTransaction): TransferReviewSplit | null {
  if (tx.transferReview !== TRANSFER_REVIEW_SPLIT) return null;
  const parsed = transferReviewSplitSchema.safeParse(tx.transferReviewSplit);
  return parsed.success ? parsed.data : null;
}

/**
 * Does this skipped realization have a row in the review queue? (SC-160)
 *
 * The predicate is deliberately the queue's, not "everything the walk
 * declined to realize" — `pendingPredicate` in `lib/transfer-review-queue.ts`
 * is `outflow AND transfer_group_id IS NULL AND transfer_review IS NULL`, and
 * a count that ran wider would send the reader to a page holding fewer rows
 * than the number that sent them there, with no way to reach zero.
 *
 * It follows that predicate and NOT the queue's visible count, which since
 * SC-375 an address rule can make smaller. A rule writes nothing to a row, so
 * a hidden row still pops its lots and still books no gain; this count is
 * about the gain that was deferred, not about the question that was asked.
 *
 * What that leaves out is the half-linked outflow — a `transfer_group_id`
 * whose paired inflow is not in the walk. It books nothing either, but it is
 * not an unanswered question: at a snapshot date before the inflow leg
 * occurred, not realizing is the correct and temporary answer, and the day
 * the pair completes it resolves itself.
 */
function countsAsUnreviewed(tx: HoldingTransaction): boolean {
  return tx.transferGroupId === null && tx.transferReview === null;
}

// Outflows that move assets *out* of the tracked portfolio with no
// buyer on the other side. A withdraw / transfer_out that's linked
// to a `transfer_in` on the same `transfer_group_id` is just a hop
// between the user's own accounts — handled by `walkComponent` which
// re-homes the lots intact (no realized PnL).
//
// An *unlinked* outflow is one of three things and we cannot tell which
// from the row: a move to an account we cannot see, a genuine exit (gift,
// P2P sale settled off-platform), or a pairing the nightly ±1%/±30min
// matcher simply failed to make. Until SC-150 all three were realized at
// fair market value, which made the third case invent a disposal and a
// gain — one-directional, always upward, on the chart the user reads.
//
// Now only a person's `left_control` answer realizes; everything else pops
// its lots and books nothing. See the neutral-outflow branch of `walkPool`,
// and `TransferReviewService` for the queue that collects the unanswered ones.
//
// That trade has a cost, and SC-160 is it being paid out loud: where a
// genuine off-platform disposal sits unanswered, realized PnL understates
// by the gain nobody booked. `transfersUnreviewed` counts those rows so the
// figure can carry the caveat and point at the queue that clears it.
const OUTFLOW_NEUTRAL_KINDS = new Set(['withdraw', 'transfer_out']);
// Fees are ignored for cost basis in the MVP. A more accurate
// accounting model would deduct fees from realized PnL on the same
// transaction, but that requires per-tx fee allocation logic that
// matters more for tax reporting than for a chart.

/**
 * Per-holding cost-basis walker.
 *
 * Reads the holding's transaction history up to `at`, walks through
 * each event in chronological order, maintains a queue of open lots
 * (each with qty + cost in base currency), and accumulates realized
 * PnL whenever a disposal takes lots out of the queue.
 *
 * **Which lots a disposal takes is the caller's choice since SC-462**, and it
 * is the only thing about this walk that varies by tax regime — see
 * `lib/lot-matching.ts`. `fifo` is the default and is unchanged in every
 * respect; `uk_section_104` applies HMRC's identification rules (same day,
 * then the following 30 days, then a pooled average cost). Everything else
 * here — what a row is worth, whether an unlinked withdrawal is a disposal at
 * all, where a lot lives after a transfer — is the same under both.
 *
 * Honest simplifications (declared in the service comment so they're
 * not silent):
 *   - Two identification methods, no LIFO and no specific-id
 *   - No wash-sale detection
 *   - Fees ignored for cost basis
 *   - deposit / reward / airdrop / interest / transfer_in lots use
 *     fair-market value at receipt (priceNative when set, otherwise
 *     held-token spot price → base via PriceGraphService); only when
 *     no price reference exists do we fall back to a zero-cost lot
 *   - unlinked withdraw / transfer_out realize PnL at FMV (proceeds
 *     minus popped cost), treating the exit as a sale against the
 *     market. Linked transfer pairs (`transferGroupId` matched in
 *     `walkComponent`) stay neutral — lots inherit to the destination
 *     holding intact.
 *
 * The `at`-time FX conversion runs through PriceGraphService so the
 * cost basis is preserved in the user's home currency at the moment
 * of purchase — matches what a brokerage statement would show.
 */
@Service()
export class CostBasisService {
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly priceGraphService = Container.get(PriceGraphService);

  async getCostBasis(
    holdingId: string,
    at: Date,
    baseCurrencyId: string,
    opts: {
      priceLookup?: PriceLookup;
      heldTokenId?: string;
      // Pre-loaded full tx history for this holding (sorted by
      // occurredAt ASC). Lets the rollup loop pay one DB read per
      // holding instead of one per (holding, day, scope).
      txs?: ReadonlyArray<HoldingTransaction>;
      // What `holding_coverage` says about this holding's history.
      // Omitted = 'unrecorded' (see HistoryCompleteness).
      historyCompleteness?: HistoryCompleteness;
      // Opt in to the per-disposal ledger (SC-152): an array the walk appends
      // its lot matches to. Omitted by every caller that only wants the
      // totals, which is all of them on the hot path — the rollup walks each
      // holding once per day per scope and has no use for a list it would
      // throw away, so leaving it out is what keeps this free.
      collect?: DisposalLotMatch[];
      // Which identification rule to match disposals under (SC-462). Omitted
      // is `fifo` — the rule every figure this product has shown was computed
      // with, so a caller that has not been taught to ask gets the number it
      // has always got rather than a silently different one.
      method?: CostBasisMethod;
      /**
       * The database transaction every read on this call goes through, or
       * `undefined` for the pool. REQUIRED — see PriceGraphOptions.tx
       * (SC-600). A `withTestDb` caller that omits it reads an empty
       * database and gets a cost basis of zero, which is a number, not an
       * error.
       */
      tx: DatabaseTransaction | undefined;
    }
  ): Promise<CostBasisAtTime> {
    const [txs, heldTokenId] = await Promise.all([
      opts.txs
        ? Promise.resolve(filterTxsUpTo(opts.txs, at))
        : this.txRepository.findForHoldingUpTo(holdingId, at, opts.tx),
      opts.heldTokenId
        ? Promise.resolve(opts.heldTokenId)
        : this.holdingRepository.findById(holdingId, opts.tx).then((h) => h?.tokenId ?? null),
    ]);
    return this.walkLots(
      opts.tx,
      txs,
      baseCurrencyId,
      heldTokenId,
      opts.priceLookup,
      opts.historyCompleteness,
      opts.collect,
      opts.method
    );
  }

  /**
   * One holding's cost basis, walked alone.
   *
   * Visible for tests + the rollup loop, which already loads txs via a
   * different pre-fetch path and can avoid the per-holding round-trip by
   * handing them in directly. `heldTokenId` lets the FMV-at-receipt fallback
   * price the inflow via the held token's spot rate when the tx itself lacks
   * priceNative — null disables the fallback (zero-cost lot for
   * INFLOW_OTHER_KINDS). `txs` must already be filtered to `<= at`; the
   * caller that needs the filter is `getCostBasis`.
   *
   * **This is `walkPool` over a component of one, and that is the whole of it
   * (SC-344).** It used to be a second, independent fold over the same events,
   * and the two disagreed on the same inputs — 26.78 from the portfolio walk
   * against 26.25 from the ledger for one production SOL holding, stable across
   * three database states, so not the ordering artifact SC-342 fixed. Three
   * separate divergences, all reachable from one row:
   *
   *   - a `transfer_group_id` whose legs are BOTH on this holding is a no-op
   *     the position never felt. `walkPool` buffers the outflow's lots and the
   *     paired inflow inherits them, cost and acquisition date intact. This
   *     walker popped them, DISCARDED them, and minted a fresh lot at the
   *     transfer date's market value — destroying cost basis on a move that
   *     never happened. Most production transfer groups are that shape.
   *   - lots were popped by array position (`lots.shift()`) rather than by
   *     acquisition date. Equivalent while the array stays date-sorted, which
   *     it does until an inherited lot re-enters carrying an older date — i.e.
   *     exactly when the case above fires.
   *   - a `carry` share whose partner never arrives was popped and dropped
   *     here, while `walkPool` buffers it and realizes it at end-of-walk when
   *     the row also carries `left_control`.
   *
   * Keeping two folds and repairing each difference would leave the property
   * that matters unproven: a component of one holding must be indistinguishable
   * from that holding walked alone, and the only way to make that true *by
   * construction* rather than by inspection is for there to be one walk.
   */
  async walkLots(
    dbTx: DatabaseTransaction | undefined,
    txs: ReadonlyArray<HoldingTransaction>,
    baseCurrencyId: string,
    heldTokenId: string | null,
    priceLookup?: PriceLookup,
    historyCompleteness: HistoryCompleteness = 'unrecorded',
    collect?: DisposalLotMatch[],
    method: CostBasisMethod = DEFAULT_COST_BASIS_METHOD
  ): Promise<CostBasisAtTime> {
    const holdingId = txs[0]?.holdingId ?? SOLE_HOLDING;
    // A single shared lot pool is this signature's contract — it takes rows,
    // not a holding — so rows from several holdings must not fan out into one
    // pool each. Re-keyed rather than rejected, and only when they actually
    // disagree, so the ordinary one-holding call clones nothing.
    const rows = txs.every((t) => t.holdingId === holdingId)
      ? txs
      : txs.map((t) => ({ ...t, holdingId }));
    const walked = await this.walkPool(
      dbTx,
      [holdingId],
      new Map([[holdingId, rows]]),
      baseCurrencyId,
      heldTokenId === null ? new Map() : new Map([[holdingId, heldTokenId]]),
      priceLookup,
      new Map([[holdingId, historyCompleteness]]),
      collect,
      method
    );
    const result = walked.get(holdingId);
    // `walkPool` emits a row for every holding it is asked about, so this
    // cannot fire. It throws rather than substituting an empty basis because an
    // empty one is not inert: `hasTransactions: false` is what makes
    // PnLAtTimeService report cost basis = current value, so the quiet path here
    // is a plausible-looking zero-gain holding, which is the class of failure
    // this ticket is about.
    if (!result) throw new Error(`walkPool emitted no row for holding ${holdingId}`);
    return result;
  }

  /**
   * Transfer-aware cost-basis walk across a set of holdings linked by
   * `transfer_group_id`.
   *
   * A transfer between a user's own accounts is not a taxable sale: the
   * source `transfer_out` must NOT realize PnL, and the destination
   * `transfer_in` must inherit the original lots' cost and acquisition
   * date rather than opening a fresh market-value lot. Per-holding cost
   * basis therefore cannot be computed in isolation — this walks every
   * holding in the transfer-connected component on a single shared lot
   * ledger where each lot is tagged with the holding it currently
   * resides in. A holding's reported cost basis is the cost of the lots
   * residing in it at `at`, which keeps account / institution / user
   * aggregation additive.
   *
   * A component of ONE holding is a legitimate and common input, not a
   * degenerate one: most production transfer groups have both legs on the
   * same holding. It is also the same walk `walkLots` performs — see there
   * for why that is one function now and not two (SC-344).
   */
  async walkComponent(
    dbTx: DatabaseTransaction | undefined,
    holdingIds: ReadonlyArray<string>,
    txsByHolding: ReadonlyMap<string, ReadonlyArray<HoldingTransaction>>,
    at: Date,
    baseCurrencyId: string,
    heldTokenByHolding: ReadonlyMap<string, string>,
    priceLookup?: PriceLookup,
    historyByHolding: ReadonlyMap<string, HistoryCompleteness> = new Map(),
    collect?: DisposalLotMatch[],
    method: CostBasisMethod = DEFAULT_COST_BASIS_METHOD
  ): Promise<Map<string, CostBasisAtTime>> {
    const upTo = new Map<string, ReadonlyArray<HoldingTransaction>>();
    for (const h of holdingIds) upTo.set(h, filterTxsUpTo(txsByHolding.get(h) ?? [], at));
    return this.walkPool(
      dbTx,
      holdingIds,
      upTo,
      baseCurrencyId,
      heldTokenByHolding,
      priceLookup,
      historyByHolding,
      collect,
      method
    );
  }

  /**
   * The walk. One shared FIFO lot pool across `holdingIds`, each lot tagged
   * with the holding it currently resides in.
   *
   * `txsByHolding` is already sliced to `<= at` — the two public entry points
   * differ in nothing else, and pushing the cutoff up to them is what lets
   * `walkLots` hand over rows it has already filtered instead of inventing a
   * sentinel date to defeat a second filter.
   */
  private async walkPool(
    dbTx: DatabaseTransaction | undefined,
    holdingIds: ReadonlyArray<string>,
    txsByHolding: ReadonlyMap<string, ReadonlyArray<HoldingTransaction>>,
    baseCurrencyId: string,
    heldTokenByHolding: ReadonlyMap<string, string>,
    priceLookup?: PriceLookup,
    historyByHolding: ReadonlyMap<string, HistoryCompleteness> = new Map(),
    collect?: DisposalLotMatch[],
    method: CostBasisMethod = DEFAULT_COST_BASIS_METHOD
  ): Promise<Map<string, CostBasisAtTime>> {
    // Flatten + globally order every tx in the component, in the canonical
    // ledger order (`lib/ledger-order.ts`). On equal timestamps an outflow
    // sorts before an inflow so a transfer_out buffers its lots before the
    // paired transfer_in needs them; past that the order is a function of the
    // rows rather than of how Postgres stored them (SC-342).
    const events: HoldingTransaction[] = [];
    const hasTxByHolding = new Map<string, boolean>();
    for (const h of holdingIds) {
      const txs = txsByHolding.get(h) ?? [];
      hasTxByHolding.set(h, txs.length > 0);
      for (const tx of txs) events.push(tx);
    }
    const ordered = sortLedgerEvents(events);
    // Decided before the fold, because rule 2 matches FORWARDS in time: a
    // disposal can be identified with a purchase made up to 30 days after it,
    // which no sequential walk can answer at the moment it reaches the
    // disposal. Neither rule reads a price, so the whole matching is a
    // function of quantities and dates and can be settled up front. FIFO asks
    // for none of this and pays for none of it.
    const acquisitionByTxId = new Map(ordered.filter(isPlannableAcquisition).map((t) => [t.id, t]));
    const plan: Section104Plan =
      method === 'uk_section_104'
        ? planSection104Matches(...section104Inputs(ordered))
        : EMPTY_SECTION_104_PLAN;
    const drawFromPool = poolDrawFor(method);

    const lots: ComponentLot[] = [];
    const realizedByHolding = new Map<string, Decimal>();
    // Doubt is attributed to the holding whose transaction raised it, so
    // one truncated exchange account in a transfer component does not
    // flag the wallet it sent coins to. Lots that *move* carry their
    // cost intact, so a stale valuation on the source is a fact about
    // the source's basis.
    const doubtByHolding = new Map<string, Doubt>();
    // Attributed the same way and for the same reason: an unanswered exit is
    // a fact about the holding it left, and the queue row names that holding.
    const unreviewedByHolding = new Map<string, number>();
    // Ledger rows are graded against the *disposing* holding's history, the
    // same attribution doubt and the unreviewed count already use: a lot that
    // moved across a transfer carries its cost intact, so what a disposal out
    // of this holding rests on is this holding's coverage.
    const record = (
      tx: HoldingTransaction,
      qtyAbs: Decimal,
      proceeds: TxValuation | null,
      slices: readonly CostLot[],
      outcome: DisposalOutcome,
      portion: PortionRef = WHOLE_PORTION
    ): void => {
      if (collect) {
        recordDisposal(
          collect,
          tx,
          qtyAbs,
          proceeds,
          slices,
          outcome,
          historyByHolding.get(tx.holdingId) ?? 'unrecorded',
          portion
        );
      }
    };
    const doubtFor = (holdingId: string): Doubt => {
      const existing = doubtByHolding.get(holdingId);
      if (existing) return existing;
      const created = new Doubt();
      doubtByHolding.set(holdingId, created);
      return created;
    };
    // Lots popped by a linked transfer_out, keyed by transfer_group_id,
    // waiting for the paired transfer_in to inherit them.
    const pending = new Map<string, ComponentLot[]>();
    // Parallel ledger of per-outflow exit metadata, keyed by the same
    // transfer_group_id. If the paired transfer_in never arrives by
    // end of walk, each entry is realized at FMV on its source holding.
    // FMV is computed *lazily* at end-of-walk so paired transfers (the
    // common case) never trigger a price-graph lookup.
    const pendingRealization = new Map<
      string,
      Array<{
        tx: HoldingTransaction;
        holdingId: string;
        qtyAbs: Decimal;
        heldTokenId: string | null;
        popped: ComponentLot[];
        portion: PortionRef;
      }>
    >();
    const addRealized = (holdingId: string, amount: Decimal): void => {
      realizedByHolding.set(
        holdingId,
        (realizedByHolding.get(holdingId) ?? new Decimal(0)).add(amount)
      );
    };
    // Take `wantQty` units out of `holdingId`'s open lots — oldest first under
    // `fifo`, at the pool's average cost under `uk_section_104`. Everything
    // the identification rules have NOT claimed comes from here, which under
    // FIFO is everything.
    const popHolding = (holdingId: string, wantQty: Decimal): ComponentLot[] =>
      drawFromPool(lots, holdingId, wantQty) as ComponentLot[];

    // One acquisition's worth in base currency, memoised, always at its FULL
    // quantity. A bed-and-breakfast match asks for it BEFORE the walk reaches
    // the acquisition's own event, and asking twice would be two price calls
    // and two chances to disagree. Slices take a share of the whole exactly
    // the way `recordDisposal` splits proceeds, so a lot and the pro-rata part
    // of it that a disposal claims cannot round apart.
    const acquisitionValues = new Map<string, TxValuation | null>();
    const acquisitionValue = async (tx: HoldingTransaction): Promise<TxValuation | null> => {
      const hit = acquisitionValues.get(tx.id);
      if (hit !== undefined) return hit;
      const value = await this.txValueInBase(
        dbTx,
        tx,
        new Decimal(tx.quantity).abs(),
        baseCurrencyId,
        heldTokenByHolding.get(tx.holdingId) ?? null,
        priceLookup
      );
      acquisitionValues.set(tx.id, value);
      return value;
    };

    // What one disposal consumes: the acquisitions the identification rules
    // gave it first, then the pool for the rest. Under FIFO the plan is empty
    // and this is `popHolding` and nothing else.
    const matchedLots = async (
      key: string,
      holdingId: string,
      wantQty: Decimal
    ): Promise<ComponentLot[]> => {
      const matches = plan.forward.get(key);
      if (!matches || matches.length === 0) return popHolding(holdingId, wantQty);
      const slices: ComponentLot[] = [];
      let claimed = new Decimal(0);
      for (const match of matches) {
        const acq = acquisitionByTxId.get(match.acquisitionTxId);
        if (!acq) continue;
        const full = new Decimal(acq.quantity).abs();
        if (full.lte(0)) continue;
        const value = await acquisitionValue(acq);
        slices.push({
          qty: match.qty,
          cost: value === null ? new Decimal(0) : value.amount.mul(match.qty).div(full),
          // The acquisition's OWN date, even when it is after the disposal.
          // `holdingDays` clamps at zero, and a negative holding period is not
          // a thing this ledger can say — but the date is what identifies the
          // match, and hiding it would leave a reader unable to see why a
          // purchase they made later paid for a sale they made earlier.
          date: acq.occurredAt,
          holdingId,
          stale: value?.stale ?? false,
          unpriced: value === null,
        });
        claimed = claimed.add(match.qty);
      }
      return [...slices, ...popHolding(holdingId, wantQty.minus(claimed))];
    };

    for (const tx of ordered) {
      const holdingId = tx.holdingId;
      const qtyAbs = new Decimal(tx.quantity).abs();
      if (qtyAbs.isZero()) continue;
      const heldTokenId = heldTokenByHolding.get(holdingId) ?? null;

      if (INFLOW_BUY_KINDS.has(tx.kind) || INFLOW_OTHER_KINDS.has(tx.kind)) {
        const tgid = tx.transferGroupId;
        const buffered = tgid ? pending.get(tgid) : undefined;
        if (
          tgid &&
          buffered &&
          (tx.kind === 'transfer_in' || tx.kind === 'deposit') &&
          carriesAcross(heldTokenByHolding, buffered, heldTokenId)
        ) {
          // Paired transfer_in: inherit the buffered lots (cost +
          // acquisition date intact), re-homed to this holding. The
          // matched outflow accumulators get discarded — the lots are
          // still in the pool, so end-of-walk realization shouldn't
          // double-book PnL on them.
          pending.delete(tgid);
          pendingRealization.delete(tgid);
          for (const lot of rehome(buffered, qtyAbs, holdingId)) lots.push(lot);
          continue;
        }
        const cost = await acquisitionValue(tx);
        doubtFor(holdingId).observe(cost);
        // Units a same-day or bed-and-breakfast disposal already claimed never
        // reach the Section 104 pool — that is what those rules DO. The
        // disposal booked them when it was walked (or will, for a same-day
        // acquisition the walk reaches first), so adding them here would count
        // one purchase twice. Under FIFO nothing is ever reserved and this
        // subtracts zero.
        const reserved = plan.reserved.get(tx.id) ?? new Decimal(0);
        const open = qtyAbs.minus(reserved);
        if (open.gt(0)) {
          lots.push({
            qty: open,
            cost: cost === null ? new Decimal(0) : cost.amount.mul(open).div(qtyAbs),
            date: tx.occurredAt,
            holdingId,
            stale: cost?.stale ?? false,
            unpriced: cost === null,
          });
        }
        continue;
      }

      if (OUTFLOW_SELL_KINDS.has(tx.kind)) {
        const proceeds = await this.txValueInBase(
          dbTx,
          tx,
          qtyAbs,
          baseCurrencyId,
          heldTokenId,
          priceLookup
        );
        doubtFor(holdingId).observe(proceeds);
        const popped = await matchedLots(`${tx.id}#${WHOLE_PORTION.index}`, holdingId, qtyAbs);
        record(tx, qtyAbs, proceeds, popped, proceeds === null ? 'unpriced' : 'realized');
        if (proceeds !== null) {
          const soldCost = popped.reduce((s, l) => s.add(l.cost), new Decimal(0));
          addRealized(holdingId, proceeds.amount.minus(soldCost));
        }
        // proceeds === null → neither the execution rate nor the held token
        // could be converted (SC-397). Pop at zero realized; the row carries
        // `unpriced`, which is what the ledger renders a sentence from.
        continue;
      }

      if (OUTFLOW_NEUTRAL_KINDS.has(tx.kind)) {
        const tgid = tx.transferGroupId;
        // One share at a time since SC-181, popping off the shared component
        // ledger in the order the reader wrote them. An unsplit row yields
        // exactly one share and takes the same three branches it always did.
        // Each share pops its own lots off the same pool, so the realized part
        // of a split realizes against the lots it actually consumed rather than
        // against a pro-rata slice of the whole — the same lot walk, asked the
        // same question, about less.
        //
        // A `paired` share is the case this generalisation was built for: a
        // 4,000 withdrawal where 3,500 arrived and 500 was the fee is the
        // ±1%-outside-tolerance row the matcher refuses, and the honest answer
        // is that 3,500 of it carries its lots across and 500 of it left.
        let countedUnreviewed = false;
        for (const portion of outflowPortions(tx, qtyAbs)) {
          // Deliberately unrecorded in the carry branch. A move between the
          // reader's own accounts is not a disposal and never was one — the
          // lots carry across intact — so a ledger row for it would be an
          // event that did not happen. If the pair never arrives, the
          // end-of-walk pass records it there, as the open question it is.
          if (portion.action === 'carry' && tgid) {
            // A move between the reader's own accounts is not a disposal, so
            // no identification rule reaches it: it draws from the pool, which
            // under `uk_section_104` hands it the average cost it should carry
            // to the destination.
            const popped = popHolding(holdingId, portion.qty);
            // Buffer the popped lots for the paired transfer_in. The FMV
            // lookup is deferred — most linked outflows get paired, and we
            // don't want to make a price call we'll throw away.
            // Copied, not aliased. `popped` is also handed to the accumulator
            // below and read again at end-of-walk, so storing it as the group's
            // bucket makes the two the same array: a second carry share into
            // the same group appends its lots to the bucket and thereby to the
            // FIRST share's own popped list. That share then books its
            // neighbour's cost against its own proceeds (SC-90).
            const bucket = pending.get(tgid);
            if (bucket) bucket.push(...popped);
            else pending.set(tgid, [...popped]);
            const accs = pendingRealization.get(tgid) ?? [];
            accs.push({ tx, holdingId, qtyAbs: portion.qty, heldTokenId, popped, portion });
            pendingRealization.set(tgid, accs);
            continue;
          }
          if (portion.action === 'fee') {
            // A charge taken out of what left (SC-888). Nothing is realized —
            // the bank took the money, the reader did not sell it — and the
            // units are gone from the pool because they are gone from the
            // balance.
            //
            // Where the row is linked, the popped lots join the SAME buffer
            // the carry share filled, with no realization accumulator beside
            // them: a fee never becomes a disposal, whatever happens to the
            // pair. That is `rehome`'s own rule, reached deliberately rather
            // than by accident — "the fee is an incidental cost of the
            // transfer, not a disposal of the units it consumed, so the whole
            // cost carries onto the units that survive it". Answering
            // "3,500 paired, 500 a fee" therefore lands the destination on the
            // same basis as answering `paired` for the whole 4,000 does today,
            // which is the arithmetic this ticket is explicitly not changing.
            const popped = popHolding(holdingId, portion.qty);
            if (tgid) {
              // Copied, not aliased — SC-90, and for the identical reason the
              // carry branch gives.
              const bucket = pending.get(tgid);
              if (bucket) bucket.push(...popped);
              else pending.set(tgid, [...popped]);
            }
            record(tx, portion.qty, null, popped, 'fee', portion);
            continue;
          }
          if (portion.action === 'realize') {
            // The user said this share left their control. Realize at FMV like
            // a sale — and identify it like one, because it IS one: this share
            // left the portfolio, which is the whole of what the same-day and
            // 30-day rules are about. When proceeds is null (no priceable route
            // at occurredAt) fall through silently at zero realized rather than
            // fabricating a phantom loss.
            const popped = await matchedLots(`${tx.id}#${portion.index}`, holdingId, portion.qty);
            const proceeds = await this.txValueInBase(
              dbTx,
              tx,
              portion.qty,
              baseCurrencyId,
              heldTokenId,
              priceLookup
            );
            doubtFor(holdingId).observe(proceeds);
            record(
              tx,
              portion.qty,
              proceeds,
              popped,
              proceeds === null ? 'unpriced' : 'realized',
              portion
            );
            if (proceeds !== null) {
              const poppedCost = popped.reduce((s, l) => s.add(l.cost), new Decimal(0));
              addRealized(holdingId, proceeds.amount.minus(poppedCost));
            }
            continue;
          }
          // Nothing realized — see `OUTFLOW_NEUTRAL_KINDS` for why. The lots are
          // popped either way; where the question is still open it lives in
          // the Review queue, and is counted here so the figure can say the
          // queue is holding part of its answer (SC-160). A `carry` share with
          // no group id on the row is a half-written pairing and says so.
          //
          // No identification rule either: nothing was disposed of, so there is
          // nothing for a same-day acquisition to be matched against. The units
          // leave at pool cost.
          const popped = popHolding(holdingId, portion.qty);
          record(
            tx,
            portion.qty,
            null,
            popped,
            portion.action === 'carry' ? 'awaiting_pair' : portion.held,
            portion
          );
          // Once per transaction: the count is of queue rows, and the queue
          // holds one row per transaction however many parts its answer has.
          if (!countedUnreviewed && countsAsUnreviewed(tx)) {
            unreviewedByHolding.set(holdingId, (unreviewedByHolding.get(holdingId) ?? 0) + 1);
            countedUnreviewed = true;
          }
        }
      }
      // Unknown kind — skip; balance is handled by BalanceAtTimeService.
    }

    // Any transfer_out lots still buffered at end of walk carry a
    // `transfer_group_id` whose paired `transfer_in` never arrived — a
    // half-linked move. The lots are gone from the source holding either
    // way; what is in question is whether a gain should be booked.
    //
    // Same rule as the unlinked case (SC-150), because it is the same
    // question reached a different way: a group id with only one leg is
    // no more evidence of a sale than no group id at all. It is usually
    // evidence of an import that fetched one side.
    //
    // Not the same *count*, though — see `countsAsUnreviewed`. These carry a
    // group id, so the review queue does not hold them and there is nothing
    // for a reader to go and answer.
    for (const accs of pendingRealization.values()) {
      for (const acc of accs) {
        // A share that got here is one the reader answered `paired` (or the
        // matcher linked) and whose partner never turned up. Never realized on
        // a split's say-so: the reader said this share moved, not that it was
        // sold, and `isConfirmedDisposal` is about the whole row.
        if (acc.portion.count > 1 || !isConfirmedDisposal(acc.tx)) {
          record(acc.tx, acc.qtyAbs, null, acc.popped, 'awaiting_pair', acc.portion);
          continue;
        }
        const proceeds = await this.txValueInBase(
          dbTx,
          acc.tx,
          acc.qtyAbs,
          baseCurrencyId,
          acc.heldTokenId,
          priceLookup
        );
        doubtFor(acc.holdingId).observe(proceeds);
        record(
          acc.tx,
          acc.qtyAbs,
          proceeds,
          acc.popped,
          proceeds === null ? 'unpriced' : 'realized',
          acc.portion
        );
        if (proceeds !== null) {
          const poppedCost = acc.popped.reduce((s, l) => s.add(l.cost), new Decimal(0));
          addRealized(acc.holdingId, proceeds.amount.minus(poppedCost));
        }
      }
    }
    pendingRealization.clear();

    const out = new Map<string, CostBasisAtTime>();
    for (const h of holdingIds) {
      const holdingLots = lots.filter((l) => l.holdingId === h);
      const hasTransactions = hasTxByHolding.get(h) ?? false;
      out.set(h, {
        openQty: holdingLots.reduce((s, l) => s.add(l.qty), new Decimal(0)),
        costBasis: holdingLots.reduce((s, l) => s.add(l.cost), new Decimal(0)),
        realizedPnl: realizedByHolding.get(h) ?? new Decimal(0),
        lots: holdingLots.map((l) => ({
          qty: l.qty,
          cost: l.cost,
          date: l.date,
          stale: l.stale,
          unpriced: l.unpriced,
        })),
        hasTransactions,
        basisQuality: gradeBasis(
          hasTransactions,
          historyByHolding.get(h) ?? 'unrecorded',
          doubtByHolding.get(h)
        ),
        transfersUnreviewed: unreviewedByHolding.get(h) ?? 0,
      });
    }
    return out;
  }

  /**
   * This row's value in base currency at `occurredAt`.
   *
   * The implementation moved to `lib/tx-valuation.ts` under SC-457, unchanged,
   * because the returns engine has to value an external flow exactly the way
   * the same transaction's cost basis is valued. Two copies would be two
   * answers to one question, and the difference would land as an unexplained
   * gap between the return figure and the gain beside it.
   */
  private async txValueInBase(
    dbTx: DatabaseTransaction | undefined,
    tx: HoldingTransaction,
    qtyAbs: Decimal,
    baseCurrencyId: string,
    heldTokenId: string | null,
    priceLookup?: PriceLookup
  ): Promise<TxValuation | null> {
    return valueTransactionInBase(
      this.priceGraphService,
      dbTx,
      tx,
      qtyAbs,
      baseCurrencyId,
      heldTokenId,
      priceLookup
    );
  }
}

// Accumulates the reasons a walk's output is less than a settled figure.
// Two of them, both one-directional in their effect on reported gain: a
// leg valued from a price beyond the staleness cap, and a leg nothing
// could value at all (which books a zero-cost lot, so the whole disposal
// becomes gain).
class Doubt {
  stalePriced = false;
  unpriced = false;

  observe(valuation: TxValuation | null): void {
    if (valuation === null) this.unpriced = true;
    else if (valuation.stale) this.stalePriced = true;
  }

  get any(): boolean {
    return this.stalePriced || this.unpriced;
  }
}

function gradeBasis(
  hasTransactions: boolean,
  history: HistoryCompleteness,
  doubt: Doubt | undefined
): CostBasisQuality {
  if (!hasTransactions) return 'unknown';
  if (history === 'incomplete') return 'partial';
  return doubt?.any ? 'partial' : 'known';
}

// Slice a pre-loaded full tx history down to events at or before
// `at`. Avoids repeating the per-day DB read in the rollup hot path
// when the caller hands in the whole history once.
function filterTxsUpTo(
  txs: ReadonlyArray<HoldingTransaction>,
  at: Date
): ReadonlyArray<HoldingTransaction> {
  const cutoff = at.getTime();
  return txs.filter((t) => t.occurredAt.getTime() <= cutoff);
}

/**
 * The holding a `walkLots` call is about when its rows cannot say — i.e. when
 * there are none. Never reaches a lot, a ledger row or a returned figure: an
 * empty history produces an empty pool, and the only thing this key does is
 * let `walkPool` return the `hasTransactions: false` row the caller expects.
 */
const SOLE_HOLDING = '';

/**
 * Which non-realizing outcome an outflow the walk declined to realize is.
 *
 * Three different situations produce the identical arithmetic — lots popped,
 * nothing booked — and the only thing that tells them apart is what a person
 * can do about each. A group id with one leg needs an import, not an answer; a
 * `NULL` review is the queue's; anything else has already been answered
 * `untracked`, and the correct action is none.
 *
 * Only reached for a WHOLE answer — `outflowPortions` decides per share
 * otherwise — with one exception it has to cover: a `split` marker whose
 * payload will not parse. That row is not `retained`; nobody said it was
 * retained. It needs an answer, and `unreviewed` is the outcome that says so.
 */
/**
 * May the lots buffered by a linked outflow carry into this arrival, or is the
 * pair a CONVERSION wearing a transfer's clothes (SC-506)?
 *
 * A lot's `cost` is denominated in base currency and its `qty` is denominated
 * in the asset — so carrying a lot from one asset to another is not a units
 * conversion problem that a scale factor could fix, it is a category error.
 * The destination's pool would be measured in the source's units: on the
 * SC-465 demo seed, a GBP current account receiving eighteen EUR->GBP
 * conversions ends the window holding 45,444.82 lot units against a balance of
 * 11,380.08, at 0.844 per unit instead of 1.000, and every ordinary bill paid
 * out of it thereafter books the 15.6% difference as a realized gain — 24,351.47
 * of it, with no sale anywhere in the ledger. The same arithmetic runs the
 * other way into a USD brokerage cash pool, which underflows to zero and then
 * reports a 0.00 cost basis against a five-figure balance.
 *
 * So: refuse, and let the arrival open a lot at its own market value while the
 * departure falls to the end-of-walk pass, which already has a considered rule
 * for a linked outflow whose partner it cannot use.
 *
 * The refusal is PROOF-BASED, not precautionary. When either side's token is
 * unknown to the caller the pair carries as it always did — an unknown is not
 * evidence of a boundary, and a walk that stopped carrying on a missing map
 * entry would break every same-token transfer to protect against a case it
 * cannot see.
 */
function carriesAcross(
  heldTokenByHolding: ReadonlyMap<string, string>,
  buffered: ReadonlyArray<ComponentLot>,
  arrivalTokenId: string | null
): boolean {
  if (arrivalTokenId === null) return true;
  for (const lot of buffered) {
    const sourceTokenId = heldTokenByHolding.get(lot.holdingId);
    if (sourceTokenId !== undefined && sourceTokenId !== arrivalTokenId) return false;
  }
  return true;
}

/**
 * The buffered lots, re-homed to the arrival and scaled to THE UNITS THAT
 * ACTUALLY ARRIVED (SC-506).
 *
 * A network fee makes the two legs of an honest same-token transfer differ:
 * slightly less arrives than left. The walk used to push the departing
 * quantity, so the destination's pool permanently over-reported by the fee —
 * a minority of production's transfer groups drift this way, worth a small
 * amount of misplaced basis, and the biggest is a low single-digit percentage
 * of its own transfer. The `+-1%` matcher tolerance is what has kept it small
 * rather than anything in this function.
 *
 * `cost` is deliberately NOT scaled down with the quantity. The fee is an
 * incidental cost of the transfer, not a disposal of the units it consumed, so
 * the whole cost carries onto the units that survive it and the component's
 * total cost basis is conserved across the move — which is the invariant this
 * entire walk exists to hold.
 *
 * The last lot absorbs the rounding residual, for the reason `drawPooled`
 * states: a pool left a hair short of what a later disposal asks for emits a
 * shortfall row priced as pure gain.
 */
function rehome(
  buffered: ReadonlyArray<ComponentLot>,
  arrivedQty: Decimal,
  holdingId: string
): ComponentLot[] {
  const sent = buffered.reduce((sum, lot) => sum.add(lot.qty), new Decimal(0));
  const out: ComponentLot[] = [];
  let placed = new Decimal(0);
  for (let i = 0; i < buffered.length; i++) {
    const lot = buffered[i] as ComponentLot;
    const last = i === buffered.length - 1;
    const qty = sent.lte(0)
      ? lot.qty
      : last
        ? arrivedQty.minus(placed)
        : lot.qty.mul(arrivedQty).div(sent);
    placed = placed.add(qty);
    out.push({
      qty,
      cost: lot.cost,
      date: lot.date,
      holdingId,
      stale: lot.stale,
      unpriced: lot.unpriced,
    });
  }
  return out;
}

function skippedOutcome(tx: HoldingTransaction): DisposalOutcome {
  if (tx.transferGroupId !== null) return 'awaiting_pair';
  if (tx.transferReview === TRANSFER_REVIEW_SPLIT) return 'unreviewed';
  if (tx.transferReview === TRANSFER_REVIEW_FEE) return 'fee';
  return tx.transferReview === null ? 'unreviewed' : 'retained';
}

/**
 * Is this row an ACQUISITION the identification rules may match a disposal
 * against?
 *
 * Every inflow the walk opens a lot for, minus the one shape that is not an
 * acquisition at all: a `transfer_in` / `deposit` carrying a
 * `transfer_group_id`, which is the reader moving their own coins between
 * their own accounts. `walkPool` inherits the original lots through it, cost
 * and date intact, precisely because no acquisition happened — and HMRC agrees
 * for the same reason, there being no change of beneficial ownership. Letting
 * one satisfy the 30-day rule would identify a disposal against a purchase
 * nobody made.
 *
 * The kind gate matches `walkPool`'s inheritance branch exactly, `buy`
 * included: a `buy` carrying a group id is still a purchase, and the walk
 * treats it as one.
 */
function isPlannableAcquisition(tx: HoldingTransaction): boolean {
  if (!INFLOW_BUY_KINDS.has(tx.kind) && !INFLOW_OTHER_KINDS.has(tx.kind)) return false;
  if (new Decimal(tx.quantity).abs().isZero()) return false;
  return !(tx.transferGroupId !== null && (tx.kind === 'transfer_in' || tx.kind === 'deposit'));
}

/**
 * The ledger reduced to what the identification rules need: quantities, dates
 * and which side each row is on. No price is read, which is why this can run
 * before the walk.
 *
 * The disposal side is deliberately narrower than "every outflow". A `carry`
 * share moves coins between the reader's own accounts and a `hold` share books
 * nothing at all — neither is a disposal, and matching an acquisition against
 * one would consume it for a gain nobody realized.
 *
 * **One disposal shape is knowingly left out**: a `left_control` outflow that
 * also carries a `transfer_group_id` whose partner never arrives. `walkPool`
 * realizes those in an end-of-walk pass, and whether the partner arrives is
 * not decidable here without re-running the pairing the walk itself performs.
 * They fall through to the pool. That is a half-linked import artefact rather
 * than an ordinary sale, and it is named in
 * `docs/features/cost-basis-methods.md` rather than left to be discovered.
 */
function section104Inputs(
  ordered: readonly HoldingTransaction[]
): [PlanAcquisition[], PlanDisposal[]] {
  const acquisitions: PlanAcquisition[] = [];
  const disposals: PlanDisposal[] = [];
  for (const tx of ordered) {
    const qtyAbs = new Decimal(tx.quantity).abs();
    if (qtyAbs.isZero()) continue;
    if (isPlannableAcquisition(tx)) {
      acquisitions.push({
        txId: tx.id,
        holdingId: tx.holdingId,
        occurredAt: tx.occurredAt,
        qty: qtyAbs,
      });
      continue;
    }
    if (OUTFLOW_SELL_KINDS.has(tx.kind)) {
      disposals.push({
        key: `${tx.id}#${WHOLE_PORTION.index}`,
        holdingId: tx.holdingId,
        occurredAt: tx.occurredAt,
        qty: qtyAbs,
      });
      continue;
    }
    if (!OUTFLOW_NEUTRAL_KINDS.has(tx.kind)) continue;
    if (tx.transferGroupId !== null) continue;
    for (const portion of outflowPortions(tx, qtyAbs)) {
      if (portion.action !== 'realize') continue;
      disposals.push({
        key: `${tx.id}#${portion.index}`,
        holdingId: tx.holdingId,
        occurredAt: tx.occurredAt,
        qty: portion.qty,
      });
    }
  }
  return [acquisitions, disposals];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Turn one outflow and the lots it consumed into ledger rows.
 *
 * Two things happen here that a scalar accumulator never had to do:
 *
 * 1. **Proceeds are split across the matched lots pro-rata by quantity**, so
 *    each row carries the share of the disposal belonging to its acquisition
 *    date. The split is by quantity and the quantities sum to the disposal's
 *    own quantity, so the slices sum back to its proceeds exactly — and the
 *    per-row gains therefore sum to the scalar the walk accumulates.
 * 2. **A shortfall becomes its own row with `acquiredAt: null`.** The walk pops
 *    what lots it has and stops; a disposal of 10 units against 4 units of
 *    recorded acquisitions leaves 6 units whose basis is not zero but
 *    *unknown*. Folding those into the matched row as free gain is exactly how
 *    a truncated import turns into a confident-looking profit, so the row
 *    exists, carries its proceeds, carries no acquisition date, and is graded
 *    `unknown`.
 * 3. **Every row says which share of its outflow it belongs to** (SC-181).
 *    `qtyAbs` here is the *share's* quantity, not the transaction's, so the
 *    pro-rata split in (1) is against the share — which is what makes the
 *    realized part of a split sum to the gain the walk booked for it.
 */
function recordDisposal(
  collect: DisposalLotMatch[],
  tx: HoldingTransaction,
  qtyAbs: Decimal,
  proceeds: TxValuation | null,
  slices: readonly CostLot[],
  outcome: DisposalOutcome,
  history: HistoryCompleteness,
  portion: PortionRef = WHOLE_PORTION
): void {
  const share = (qty: Decimal): Decimal | null =>
    proceeds === null ? null : proceeds.amount.mul(qty).div(qtyAbs);
  const answerSource = disposalAnswerSourceOf(tx);

  let matched = new Decimal(0);
  for (const slice of slices) {
    matched = matched.add(slice.qty);
    const sliceProceeds = share(slice.qty);
    collect.push({
      transactionId: tx.id,
      holdingId: tx.holdingId,
      tokenId: tx.tokenId,
      kind: tx.kind,
      disposedAt: tx.occurredAt,
      acquiredAt: slice.date,
      quantity: slice.qty,
      proceeds: sliceProceeds,
      costBasis: slice.cost,
      gain: sliceProceeds === null ? null : sliceProceeds.minus(slice.cost),
      holdingDays: Math.max(
        0,
        Math.floor((tx.occurredAt.getTime() - slice.date.getTime()) / MS_PER_DAY)
      ),
      portionIndex: portion.index,
      portionCount: portion.count,
      basisQuality: gradeDisposalRow(history, slice, proceeds),
      outcome,
      valuationBasis: proceeds?.basis ?? null,
      answerSource,
    });
  }

  const shortfall = qtyAbs.minus(matched);
  if (shortfall.lte(0)) return;
  const shortfallProceeds = share(shortfall);
  collect.push({
    transactionId: tx.id,
    holdingId: tx.holdingId,
    tokenId: tx.tokenId,
    kind: tx.kind,
    disposedAt: tx.occurredAt,
    acquiredAt: null,
    quantity: shortfall,
    proceeds: shortfallProceeds,
    costBasis: new Decimal(0),
    gain: shortfallProceeds,
    holdingDays: null,
    portionIndex: portion.index,
    portionCount: portion.count,
    basisQuality: 'unknown',
    outcome,
    valuationBasis: proceeds?.basis ?? null,
    answerSource,
  });
}

/**
 * Grade one row the way a holding's basis is graded, scoped to what this row
 * actually rests on: its own lot's provenance and its own proceeds, plus the
 * holding's coverage, which qualifies everything derived from it.
 */
function gradeDisposalRow(
  history: HistoryCompleteness,
  slice: CostLot,
  proceeds: TxValuation | null
): CostBasisQuality {
  const doubt = new Doubt();
  // Only a lookup that *failed* is doubt on the proceeds side. A row that
  // never asked for a price — an unanswered exit books nothing, so the walk
  // does not price it — has no proceeds to distrust, and grading it `partial`
  // on that basis would put a caveat on every row in the review queue for a
  // figure none of them carry.
  if (proceeds !== null) doubt.observe(proceeds);
  if (slice.stale) doubt.stalePriced = true;
  if (slice.unpriced) doubt.unpriced = true;
  return gradeBasis(true, history, doubt);
}
