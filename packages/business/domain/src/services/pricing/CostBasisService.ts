import type { HoldingTransaction } from '@scani/db/schema';
import {
  TRANSFER_REVIEW_SPLIT,
  type TransferReviewSplit,
  transferReviewSplitSchema,
} from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
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
 * claim as a `false` one. Providers write `false` deliberately — Kraken
 * when its ledger endpoint pages out at 20,000 rows, the EVM base provider
 * when iteration did not cover `[0, current_block]`, `TransactionRouter`
 * for any incremental `since` run — and that is the signal this ticket is
 * about. Roughly a fifth of production holdings have no coverage row at
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
 * - `unpriced` — nothing could value it. In practice a `swap_out` with no
 *   `priceNative`, whose proceeds are denominated in a counter token this
 *   per-holding walk cannot see. Lots popped, nothing booked: booking zero
 *   proceeds would realize a phantom loss of the whole basis.
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
export type DisposalOutcome = 'realized' | 'unpriced' | 'unreviewed' | 'retained' | 'awaiting_pair';

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
 * Was this outflow answered by a person, and did they say it left the
 * portfolio? (SC-150)
 *
 * Only `left_control` realizes. `untracked` is the user saying the asset is
 * still theirs in an account we cannot see — not a disposal. `paired` never
 * reaches these branches, because pairing writes a `transfer_group_id` and
 * `walkComponent` carries the lots across instead.
 */
function isConfirmedDisposal(tx: HoldingTransaction): boolean {
  return tx.transferReview === 'left_control';
}

/**
 * One share of an outflow and what the walk does with it (SC-181).
 *
 * Every neutral outflow used to be exactly one of three things. It is now a
 * *sequence* of shares, and an unsplit row is the sequence of length one — so
 * the two walks below gained a loop and lost no branch, and a row with no
 * split takes byte-for-byte the same path it took before.
 *
 * - `carry` — the lots move to a paired inflow. Needs `transfer_group_id`.
 * - `realize` — priced at market and booked, the `left_control` answer.
 * - `hold` — the lots leave and nothing is booked. `held` says which of the
 *   several situations that produce that identical arithmetic this one is.
 */
interface OutflowPortion extends PortionRef {
  qty: Decimal;
  action: 'carry' | 'realize' | 'hold';
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
    const action: OutflowPortion['action'] =
      tx.transferGroupId !== null ? 'carry' : isConfirmedDisposal(tx) ? 'realize' : 'hold';
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
      action:
        entry.decision === 'paired'
          ? 'carry'
          : entry.decision === 'left_control'
            ? 'realize'
            : 'hold',
      // `untracked` — the user said this share is still theirs somewhere we
      // cannot see. Same sentence the ledger already has for a whole
      // `untracked` answer, because it is the same claim about less of it.
      held: 'retained',
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
 * declined to realize" — `TransferReviewService.pendingPredicate` is
 * `outflow AND transfer_group_id IS NULL AND transfer_review IS NULL`, and a
 * count that ran wider would send the reader to a page holding fewer rows
 * than the number that sent them there, with no way to reach zero.
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
// its lots and books nothing. See the branch in `walkLots` for the full
// argument, and `TransferReviewService` for the queue that collects the
// unanswered ones.
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
 * Per-holding cost-basis walker. FIFO lot accounting.
 *
 * Reads the holding's transaction history up to `at`, walks through
 * each event in chronological order, maintains a queue of open lots
 * (each with qty + cost in base currency), and accumulates realized
 * PnL whenever a sell pops lots out of the queue.
 *
 * Honest simplifications (declared in the service comment so they're
 * not silent):
 *   - FIFO only (no LIFO, no specific-id, no average-cost)
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
    } = {}
  ): Promise<CostBasisAtTime> {
    const [txs, heldTokenId] = await Promise.all([
      opts.txs
        ? Promise.resolve(filterTxsUpTo(opts.txs, at))
        : this.txRepository.findForHoldingUpTo(holdingId, at),
      opts.heldTokenId
        ? Promise.resolve(opts.heldTokenId)
        : this.holdingRepository.findById(holdingId).then((h) => h?.tokenId ?? null),
    ]);
    return this.walkLots(
      txs,
      baseCurrencyId,
      heldTokenId,
      opts.priceLookup,
      opts.historyCompleteness,
      opts.collect
    );
  }

  // Visible for tests + the rollup loop, which already loads txs
  // via a different pre-fetch path and can avoid the per-holding
  // round-trip by handing them in directly. `heldTokenId` lets the
  // FMV-at-receipt fallback price the inflow via the held token's
  // spot rate when the tx itself lacks priceNative — null disables
  // the fallback (zero-cost lot for INFLOW_OTHER_KINDS).
  async walkLots(
    txs: ReadonlyArray<HoldingTransaction>,
    baseCurrencyId: string,
    heldTokenId: string | null,
    priceLookup?: PriceLookup,
    historyCompleteness: HistoryCompleteness = 'unrecorded',
    collect?: DisposalLotMatch[]
  ): Promise<CostBasisAtTime> {
    const lots: CostLot[] = [];
    let realized = new Decimal(0);
    let unreviewed = 0;
    // Set the moment any leg of the walk is valued from something we
    // know is not a settled figure — see `degrade`.
    const doubt = new Doubt();
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
          historyCompleteness,
          portion
        );
      }
    };

    for (const tx of txs) {
      const qtyAbs = new Decimal(tx.quantity).abs();
      if (qtyAbs.isZero()) continue;

      if (INFLOW_BUY_KINDS.has(tx.kind) || INFLOW_OTHER_KINDS.has(tx.kind)) {
        const cost = await this.txValueInBase(tx, qtyAbs, baseCurrencyId, heldTokenId, priceLookup);
        doubt.observe(cost);
        lots.push({
          qty: qtyAbs,
          cost: cost?.amount ?? new Decimal(0),
          date: tx.occurredAt,
          stale: cost?.stale ?? false,
          unpriced: cost === null,
        });
        continue;
      }

      if (OUTFLOW_SELL_KINDS.has(tx.kind)) {
        const proceeds = await this.txValueInBase(
          tx,
          qtyAbs,
          baseCurrencyId,
          heldTokenId,
          priceLookup
        );
        doubt.observe(proceeds);
        if (proceeds === null) {
          // Unpriceable sell — in practice a `swap_out` with no
          // `priceNative` (its proceeds are denominated in the counter
          // token, which this per-holding walk can't value). Booking
          // proceeds of 0 would realize a phantom loss of the entire
          // popped cost basis. Pop the lots FIFO at ZERO realized
          // instead, surfacing the gap rather than fabricating a loss.
          record(tx, qtyAbs, null, popLotsFIFO(lots, qtyAbs).slices, 'unpriced');
          continue;
        }
        const popped = popLotsFIFO(lots, qtyAbs);
        record(tx, qtyAbs, proceeds, popped.slices, 'realized');
        realized = realized.add(proceeds.amount.minus(popped.cost));
        continue;
      }

      if (OUTFLOW_NEUTRAL_KINDS.has(tx.kind)) {
        // This walker is only called for *singleton* holdings (see
        // PnLAtTimeService.singletons) — holdings outside any
        // transfer-connected component. By definition every withdraw /
        // transfer_out reaching this branch is unlinked.
        //
        // Unlinked is not the same as sold (SC-150). It used to be treated
        // that way: the outflow was realized at fair market value, which
        // booked a gain whenever the nightly ±1%/±30min matcher failed to
        // pair two legs of a move between the user's own accounts. That is
        // an invented disposal, and the error only ever ran one way —
        // it manufactured gains and could never manufacture a loss.
        //
        // So realize only when a person said this left their control. An
        // unanswered outflow pops its lots — the asset is genuinely gone
        // from this holding, the balance says so — and books NOTHING,
        // which is already this walk's idiom for "we cannot value this"
        // (see the unpriceable-swap branch above). The lots leaving with
        // no gain understates realized PnL where a real off-platform
        // disposal is sitting unanswered; that is visible, answerable, and
        // the opposite direction from silently inflating it. Counted, so the
        // understatement travels with the figure (SC-160).
        //
        // Since SC-181 the answer can also apply to PART of the row: 3,500 of
        // a 4,000 withdrawal moved somewhere untracked and 500 genuinely left.
        // Each share pops its own lots off the same FIFO queue in the order
        // the reader wrote them, so the realized portion realizes against the
        // lots it actually consumed rather than against a pro-rata slice of
        // the whole — the same lot walk, asked the same question, about less.
        let countedUnreviewed = false;
        for (const portion of outflowPortions(tx, qtyAbs)) {
          if (portion.action !== 'realize') {
            const skipped = popLotsFIFO(lots, portion.qty);
            // Recorded, with no proceeds looked up. The lots really did leave
            // and the gain really was not booked — which is the whole of the
            // answer to "why did my realized figure not move", and it is
            // invisible in a scalar. Pricing it here to show what it *would*
            // have been is the review queue's job (SC-150), not this walk's:
            // that call is per-row and this one runs per holding per day.
            //
            // `carry` cannot occur here: this walker only ever sees singleton
            // holdings, so a paired share would have put the holding in a
            // component. If one ever does, holding it books nothing, which is
            // the safe direction.
            record(tx, portion.qty, null, skipped.slices, portion.held, portion);
            // Once per transaction, not once per share. The count is of
            // transactions the queue holds a row for, and the queue holds one.
            if (!countedUnreviewed && countsAsUnreviewed(tx)) {
              unreviewed += 1;
              countedUnreviewed = true;
            }
            continue;
          }
          const proceeds = await this.txValueInBase(
            tx,
            portion.qty,
            baseCurrencyId,
            heldTokenId,
            priceLookup
          );
          doubt.observe(proceeds);
          const popped = popLotsFIFO(lots, portion.qty);
          record(
            tx,
            portion.qty,
            proceeds,
            popped.slices,
            proceeds === null ? 'unpriced' : 'realized',
            portion
          );
          if (proceeds !== null) {
            realized = realized.add(proceeds.amount.minus(popped.cost));
          }
        }
      }

      // Unknown kind (fee, unknown, future kinds): skip silently.
      // The tx still affects balance via BalanceAtTimeService; cost
      // basis just stays unchanged.
    }

    const costBasis = lots.reduce((s, l) => s.add(l.cost), new Decimal(0));
    const openQty = lots.reduce((s, l) => s.add(l.qty), new Decimal(0));
    return {
      openQty,
      costBasis,
      realizedPnl: realized,
      lots,
      hasTransactions: txs.length > 0,
      basisQuality: gradeBasis(txs.length > 0, historyCompleteness, doubt),
      transfersUnreviewed: unreviewed,
    };
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
   */
  async walkComponent(
    holdingIds: ReadonlyArray<string>,
    txsByHolding: ReadonlyMap<string, ReadonlyArray<HoldingTransaction>>,
    at: Date,
    baseCurrencyId: string,
    heldTokenByHolding: ReadonlyMap<string, string>,
    priceLookup?: PriceLookup,
    historyByHolding: ReadonlyMap<string, HistoryCompleteness> = new Map(),
    collect?: DisposalLotMatch[]
  ): Promise<Map<string, CostBasisAtTime>> {
    // Flatten + globally order every tx in the component up to `at`. On
    // equal timestamps an outflow sorts before an inflow so a
    // transfer_out buffers its lots before the paired transfer_in needs
    // them.
    const events: HoldingTransaction[] = [];
    const hasTxByHolding = new Map<string, boolean>();
    for (const h of holdingIds) {
      const txs = filterTxsUpTo(txsByHolding.get(h) ?? [], at);
      hasTxByHolding.set(h, txs.length > 0);
      for (const tx of txs) events.push(tx);
    }
    events.sort((a, b) => {
      const d = a.occurredAt.getTime() - b.occurredAt.getTime();
      return d !== 0 ? d : outflowRank(a.kind) - outflowRank(b.kind);
    });

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
    // Pop oldest lots (by acquisition date) belonging to `holdingId`,
    // splitting the last lot proportionally when needed.
    const popHolding = (holdingId: string, wantQty: Decimal): ComponentLot[] => {
      const popped: ComponentLot[] = [];
      let remaining = wantQty;
      while (remaining.gt(0)) {
        let idx = -1;
        for (let i = 0; i < lots.length; i++) {
          const l = lots[i];
          if (!l || l.holdingId !== holdingId) continue;
          const best = idx === -1 ? undefined : lots[idx];
          if (!best || l.date < best.date) idx = i;
        }
        if (idx === -1) break;
        const lot = lots[idx];
        if (!lot) break;
        if (lot.qty.lte(remaining)) {
          popped.push(lot);
          remaining = remaining.minus(lot.qty);
          lots.splice(idx, 1);
        } else {
          const ratio = remaining.div(lot.qty);
          const partialCost = lot.cost.mul(ratio);
          popped.push({
            qty: remaining,
            cost: partialCost,
            date: lot.date,
            holdingId,
            stale: lot.stale,
            unpriced: lot.unpriced,
          });
          lot.qty = lot.qty.minus(remaining);
          lot.cost = lot.cost.minus(partialCost);
          remaining = new Decimal(0);
        }
      }
      return popped;
    };

    for (const tx of events) {
      const holdingId = tx.holdingId;
      const qtyAbs = new Decimal(tx.quantity).abs();
      if (qtyAbs.isZero()) continue;
      const heldTokenId = heldTokenByHolding.get(holdingId) ?? null;

      if (INFLOW_BUY_KINDS.has(tx.kind) || INFLOW_OTHER_KINDS.has(tx.kind)) {
        const tgid = tx.transferGroupId;
        const buffered = tgid ? pending.get(tgid) : undefined;
        if (tgid && buffered && (tx.kind === 'transfer_in' || tx.kind === 'deposit')) {
          // Paired transfer_in: inherit the buffered lots (cost +
          // acquisition date intact), re-homed to this holding. The
          // matched outflow accumulators get discarded — the lots are
          // still in the pool, so end-of-walk realization shouldn't
          // double-book PnL on them.
          pending.delete(tgid);
          pendingRealization.delete(tgid);
          for (const lot of buffered) {
            lots.push({
              qty: lot.qty,
              cost: lot.cost,
              date: lot.date,
              holdingId,
              stale: lot.stale,
              unpriced: lot.unpriced,
            });
          }
          continue;
        }
        const cost = await this.txValueInBase(tx, qtyAbs, baseCurrencyId, heldTokenId, priceLookup);
        doubtFor(holdingId).observe(cost);
        lots.push({
          qty: qtyAbs,
          cost: cost?.amount ?? new Decimal(0),
          date: tx.occurredAt,
          holdingId,
          stale: cost?.stale ?? false,
          unpriced: cost === null,
        });
        continue;
      }

      if (OUTFLOW_SELL_KINDS.has(tx.kind)) {
        const proceeds = await this.txValueInBase(
          tx,
          qtyAbs,
          baseCurrencyId,
          heldTokenId,
          priceLookup
        );
        doubtFor(holdingId).observe(proceeds);
        const popped = popHolding(holdingId, qtyAbs);
        record(tx, qtyAbs, proceeds, popped, proceeds === null ? 'unpriced' : 'realized');
        if (proceeds !== null) {
          const soldCost = popped.reduce((s, l) => s.add(l.cost), new Decimal(0));
          addRealized(holdingId, proceeds.amount.minus(soldCost));
        }
        // proceeds === null → unpriceable swap_out: pop at zero realized.
        continue;
      }

      if (OUTFLOW_NEUTRAL_KINDS.has(tx.kind)) {
        const tgid = tx.transferGroupId;
        // One share at a time since SC-181, popping off the shared component
        // ledger in the order the reader wrote them. An unsplit row yields
        // exactly one share and takes the same three branches it always did.
        //
        // A `paired` share is the case this generalisation was built for: a
        // 4,000 withdrawal where 3,500 arrived and 500 was the fee is the
        // ±1%-outside-tolerance row the matcher refuses, and the honest answer
        // is that 3,500 of it carries its lots across and 500 of it left.
        let countedUnreviewed = false;
        for (const portion of outflowPortions(tx, qtyAbs)) {
          const popped = popHolding(holdingId, portion.qty);
          // Deliberately unrecorded in the carry branch. A move between the
          // reader's own accounts is not a disposal and never was one — the
          // lots carry across intact — so a ledger row for it would be an
          // event that did not happen. If the pair never arrives, the
          // end-of-walk pass records it there, as the open question it is.
          if (portion.action === 'carry' && tgid) {
            // Buffer the popped lots for the paired transfer_in. The FMV
            // lookup is deferred — most linked outflows get paired, and we
            // don't want to make a price call we'll throw away.
            const bucket = pending.get(tgid);
            if (bucket) bucket.push(...popped);
            else pending.set(tgid, popped);
            const accs = pendingRealization.get(tgid) ?? [];
            accs.push({ tx, holdingId, qtyAbs: portion.qty, heldTokenId, popped, portion });
            pendingRealization.set(tgid, accs);
            continue;
          }
          if (portion.action === 'realize') {
            // The user said this share left their control. Realize at FMV like
            // a sale. When proceeds is null (no priceable route at occurredAt)
            // fall through silently at zero realized rather than fabricating
            // a phantom loss.
            const proceeds = await this.txValueInBase(
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
          // Nothing realized — see the same branch in `walkLots`. The lots are
          // popped either way; where the question is still open it lives in
          // the Review queue, and is counted here so the figure can say the
          // queue is holding part of its answer (SC-160). A `carry` share with
          // no group id on the row is a half-written pairing and says so.
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

  // Compute the transaction's value in the user's base currency at
  // tx.occurredAt. Two paths:
  //   1. `priceNative` recorded → qty × priceNative in priceNativeTokenId,
  //      converted to base.
  //   2. Fallback → qty in the *held* token, converted to base via
  //      PriceGraphService at tx.occurredAt. This catches fiat deposits
  //      (EUR balance worth €500 at receipt) and any inflow whose value
  //      can be inferred from spot pricing of the held token.
  // Returns null only when neither path resolves — caller treats null
  // as a zero-cost lot.
  //
  // The conversion's `stale` flag comes back with the amount rather than
  // being dropped on the floor (SC-151). This was the only consumer that
  // ever asked the price graph to value a *historical* instant, and it
  // took `converted.amount` and discarded everything else — so an airdrop
  // on 2025-11-05 valued from a price dated 2025-08-01 produced a cost
  // basis indistinguishable from one priced on the day. 96 days, silently.
  //
  // SWAPS are special: a 10 BTC → 100 ETH swap has proceeds in ETH,
  // not in BTC, so the held-token fallback would wrongly value the
  // BTC leg at BTC's spot price (silently understating realized PnL
  // — see prod evidence: 30 swap_out vs 25 swap_in rows in the user's
  // ledger). For swap_in/swap_out we therefore require `priceNative`
  // and refuse to guess.
  private async txValueInBase(
    tx: HoldingTransaction,
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
      if (tx.priceNativeTokenId === baseCurrencyId) return { amount: native, stale: false };
      const converted = await this.priceGraphService.convert(
        native,
        tx.priceNativeTokenId,
        baseCurrencyId,
        tx.occurredAt,
        convertOpts
      );
      if (converted) return { amount: converted.amount, stale: converted.stale };
      // priceNative recorded but no FX route: continue to the
      // held-token fallback below rather than returning null.
    }

    const isSwap = tx.kind === 'swap_in' || tx.kind === 'swap_out';
    if (isSwap) {
      // No held-token fallback for swaps — pricing the BTC leg of a
      // BTC→ETH swap at BTC's spot would imply zero realized PnL on
      // the swap, which is wrong. Return null and let the caller treat
      // the swap as a zero-cost lot, surfacing the gap rather than
      // hiding it.
      return null;
    }

    if (heldTokenId) {
      if (heldTokenId === baseCurrencyId) return { amount: qtyAbs, stale: false };
      const converted = await this.priceGraphService.convert(
        qtyAbs,
        heldTokenId,
        baseCurrencyId,
        tx.occurredAt,
        convertOpts
      );
      if (converted) return { amount: converted.amount, stale: converted.stale };
    }

    return null;
  }
}

// A transaction's value in base currency, plus whether the price that
// produced it was inside the freshness window.
interface TxValuation {
  amount: Decimal;
  stale: boolean;
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

// Ordering helper for the component walk: on equal timestamps an
// outflow (rank 0) is processed before an inflow (rank 1) so a linked
// transfer_out buffers its lots before the paired transfer_in inherits
// them.
function outflowRank(kind: string): number {
  return OUTFLOW_SELL_KINDS.has(kind) || OUTFLOW_NEUTRAL_KINDS.has(kind) ? 0 : 1;
}

// Pop lots FIFO until `wantQty` is satisfied. Returns the total cost popped
// (caller subtracts from proceeds for realized PnL) *and* the individual lot
// slices consumed, which is what the per-disposal ledger is made of.
// May split the last popped lot proportionally when wantQty < lot.qty.
//
// `slices` is the same information `cost` summarises — their costs sum to it
// by construction — and one traversal producing both is what keeps the
// ledger's rows and the chart's scalar from ever disagreeing.
function popLotsFIFO(lots: CostLot[], wantQty: Decimal): { cost: Decimal; slices: CostLot[] } {
  let remaining = wantQty;
  let totalCost = new Decimal(0);
  const slices: CostLot[] = [];
  while (remaining.gt(0) && lots.length > 0) {
    const lot = lots[0];
    if (!lot) break;
    if (lot.qty.lte(remaining)) {
      totalCost = totalCost.add(lot.cost);
      slices.push({ qty: lot.qty, cost: lot.cost, date: lot.date, ...provenanceOf(lot) });
      remaining = remaining.minus(lot.qty);
      lots.shift();
    } else {
      const ratio = remaining.div(lot.qty);
      const partialCost = lot.cost.mul(ratio);
      totalCost = totalCost.add(partialCost);
      slices.push({ qty: remaining, cost: partialCost, date: lot.date, ...provenanceOf(lot) });
      lot.qty = lot.qty.minus(remaining);
      lot.cost = lot.cost.minus(partialCost);
      remaining = new Decimal(0);
    }
  }
  return { cost: totalCost, slices };
}

function provenanceOf(lot: CostLot): { stale?: boolean; unpriced?: boolean } {
  return { stale: lot.stale, unpriced: lot.unpriced };
}

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
function skippedOutcome(tx: HoldingTransaction): DisposalOutcome {
  if (tx.transferGroupId !== null) return 'awaiting_pair';
  if (tx.transferReview === TRANSFER_REVIEW_SPLIT) return 'unreviewed';
  return tx.transferReview === null ? 'unreviewed' : 'retained';
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
