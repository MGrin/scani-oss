import type { DatabaseTransaction } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import {
  feeFitsMovement,
  isManualEditCause,
  type ManualEditCause,
  manualEditNeedsCause,
} from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { DEFAULT_OPENING_EPSILON } from './OpeningBalanceReconciliationService';

const logger = createComponentLogger('service:ManualBalanceEditService');

/**
 * The two `source` values this service writes, and nothing else writes.
 *
 * Separate from `'user-entered'` — which is a person typing a TRANSACTION —
 * because these rows describe an edit to a BALANCE that we then explained.
 * The distinction is what lets an audit ask "what did we synthesize" without
 * catching every hand-entered trade in the product.
 */
export const MANUAL_EDIT_FLOW_SOURCE = 'user-balance-edit';
export const MANUAL_EDIT_CORRECTION_SOURCE = 'user-balance-correction';

/** The dedup key every row this service writes is addressed by. */
function manualEditExternalId(editedAt: Date): string {
  return `manual-edit:${editedAt.toISOString()}`;
}

/**
 * The FEE row's dedup key, derived from the row it was carved out of
 * (SC-857).
 *
 * Suffixed from the withdrawal's own key rather than given one of its own,
 * which is the convention `StatementTransactionIngester` already writes fees
 * under: `bulkUpsert` keys on `(holding_id, source, external_id)`, so a
 * retried submission collapses onto the same two rows the first one wrote,
 * and `undoDeclaredTransfer` can find the fee from the leg it is undoing
 * without a third column to carry the relationship.
 *
 * Exported for the reason `manualEditFlowLeg` is: `TransferReviewService` has
 * to find these rows after they were written, and a second assembly of the
 * key there is one free to drift from this one — which would fail silently in
 * the worst direction, an undo reporting success having left a charge behind.
 */
export function manualEditFeeExternalId(flowExternalId: string): string {
  return `${flowExternalId}:fee`;
}

/**
 * The fee stated on a movement was not smaller than the movement itself.
 *
 * Refused rather than clamped, for the reason `undoDeclaredTransfer` gives
 * about not clamping a negative destination: silently absorbing the
 * difference produces a figure nobody chose and leaves nothing on screen
 * saying it happened. A fee equal to the whole movement also leaves no
 * transfer to declare, and a larger one would flip the withdrawal's sign.
 */
export class ManualEditFeeRefused extends Error {
  constructor(fee: string, delta: string) {
    super(`A fee of ${fee} is not smaller than the ${delta} that moved`);
    this.name = 'ManualEditFeeRefused';
  }
}

/**
 * The natural key of the flow row a manual balance edit wrote.
 *
 * Exported because two callers have to find these rows AFTER writing them:
 * `RecordHoldingMovementUseCase` and `UpdateHoldingUseCase` both link a
 * declared transfer's two legs by this key, and `LinkTransferPairsUseCase`
 * addresses each leg by `(holding, source, external_id)`.
 *
 * One assembly, here, for the reason `ManualBalanceEditResult.transactionId`
 * already gives: a second assembly elsewhere is a key free to drift from this
 * one, and a caller stamping an answer onto no row at all reports success.
 */
export function manualEditFlowLeg(
  holdingId: string,
  editedAt: Date
): { holdingId: string; source: string; externalId: string } {
  return {
    holdingId,
    source: MANUAL_EDIT_FLOW_SOURCE,
    externalId: manualEditExternalId(editedAt),
  };
}

export interface ManualBalanceEditInput {
  holding: Pick<Holding, 'id' | 'userId' | 'tokenId' | 'lastUpdated'>;
  /** The balance BEFORE the edit. */
  previousBalance: string;
  /** The balance the edit set. */
  newBalance: string;
  cause: ManualEditCause;
  /**
   * When the user says the money moved. Only read for `cause: 'flow'`; the
   * caller defaults it to now when the client sent nothing.
   */
  occurredAt: Date;
  /**
   * The instant of the edit itself, used to build the dedup key. Distinct
   * from `occurredAt`, which is when the money moved.
   */
  editedAt: Date;
  /**
   * How much of a negative `flow` was a fee rather than a movement (SC-857).
   *
   * Unsigned and strictly smaller than the delta. Read only for a `flow`
   * whose delta is negative — a fee is a charge on money going out, and a
   * `correction` restating a figure or a `growth` that writes no row has
   * nothing for it to be part of.
   */
  fee?: Decimal;
}

export interface ManualBalanceEditResult {
  cause: ManualEditCause;
  /** Signed delta, `newBalance - previousBalance`. */
  delta: Decimal;
  /** The kind written, or null when nothing was written. */
  kind: 'deposit' | 'withdraw' | 'correction' | null;
  /**
   * The row this wrote, so the caller can settle what it MEANS in the same
   * transaction (SC-606).
   *
   * Returned rather than re-found by the caller on `(holding, source,
   * externalId)`: the dedup key is assembled here and a second assembly of it
   * elsewhere is a key that can drift from this one, which would leave the
   * caller stamping an answer onto nothing and reporting success.
   */
  transactionId: string | null;
  occurredAt: Date | null;
  /**
   * The `fee` row this wrote, or null when the edit carried none (SC-857).
   *
   * Returned for the same reason `transactionId` is: the caller settles what
   * the movement MEANT in this transaction, and for a declared transfer that
   * means subtracting the fee from what reaches the destination. Handing back
   * the amount that was actually carved out — rather than letting the caller
   * re-read its own input — keeps one arithmetic authority, so a fee this
   * service declined to honour cannot silently shrink an arrival.
   */
  fee: { transactionId: string | null; quantity: Decimal } | null;
  /** Why nothing was written, when `kind` is null. */
  skipped: 'no-delta' | 'growth-needs-no-row' | null;
}

/**
 * Turns a manual balance edit into the ledger row that explains it (SC-510).
 *
 * ## What it writes, per cause
 *
 * **`flow`** — a `deposit` (delta > 0) or `withdraw` (delta < 0) for the
 * delta, at the date the USER gave. `flowRoleOf` classifies both `external`,
 * so the returns engine nets them out of the value change instead of reading
 * them as performance. That is the whole defect: add £5,000 to a manual
 * holding and, before this, the engine reported a £5,000 gain.
 *
 * **`growth`** — nothing. Deliberately, and this is the branch most likely to
 * be "fixed" by a later reader, so the reasoning is here rather than in a
 * ticket. Growth on an unpriced balance IS performance, and performance is
 * exactly what an unexplained balance rise already produces: the value series
 * is reconstructed from observations, and `BalanceAtTimeService.driftAhead`
 * spreads the unexplained drift linearly across the gap between the two
 * observations that bracket it, marking the result `interpolated`. Writing an
 * `interest` row instead would replace that honest, self-declaring ramp with a
 * step on a date nobody chose, and the step would be invented data that does
 * NOT declare itself. So the correct synthesis for growth is no synthesis, and
 * the user's answer is recorded on the holding rather than in the ledger.
 *
 * **`correction`** — a `correction` row for the delta, dated at the moment the
 * SUPERSEDED figure entered the record, not at the edit. See below.
 *
 * ## Why a correction is dated backwards
 *
 * A correction is a restatement, not an event. The honest treatment is to
 * amend the history the wrong figure governed rather than to record something
 * happening today — a decision this ticket left open and this file settles.
 *
 * The mechanism makes it cheap. `BalanceAtTimeService` anchors a past date on
 * the nearest observation at or after it and walks the ledger back; the wrong
 * figure was in force from the observation that recorded it until now. Placing
 * the `correction` row one millisecond after THAT observation means every date
 * from then on reconstructs to the corrected balance, and the discontinuity
 * sits where the mistake was made instead of where it was noticed.
 *
 * The alternative — a row dated today — puts a step change on today, which is
 * the failure `e1fa63e5` removed for flows ("stop one day absorbing ten
 * weeks") and is worse here, because for a correction the step describes
 * nothing that ever happened.
 *
 * `flowRoleOf('correction')` is `restatement`: subtracted from the value
 * series like a flow so it is not read as a gain, and excluded from the
 * investor's cashflows so it is not read as money paid in. Neither, which is
 * what a restatement is.
 *
 * It creates and disposes no cost-basis lot either — `correction` is in
 * neither `INFLOW_OTHER_KINDS` nor `OUTFLOW_SELL_KINDS` in `CostBasisService`,
 * so the walk passes over it. That is the conservative reading: there is no
 * honest acquisition price for units that were only ever a typo, and a later
 * disposal degrades its own `basisQuality` rather than inventing one.
 *
 * ## Why every branch feeds reconciliation for free
 *
 * `OpeningBalanceReconciliationService` computes
 * `holdings.balance - sum(real txs)` and synthesizes an `opening_balance` for
 * the difference. Both rows written here are real transactions, so the sum
 * moves with the balance and the computed opening does not change — no phantom
 * opening appears, and no second reconciliation path exists to drift from the
 * first. The `growth` branch leaves the gap in place, where the reconciler
 * already reports it as `unexplainedResidual` rather than backdating it.
 */
@Service()
export class ManualBalanceEditService {
  private readonly transactionRepository = Container.get(HoldingTransactionRepository);
  private readonly observationRepository = Container.get(HoldingBalanceObservationRepository);

  /**
   * Which cause applies to this edit, or a refusal.
   *
   * Three inputs, in priority order:
   *
   * 1. **What the user said this time.** Always wins, and it wins on priced
   *    holdings too — a mistyped share count is a restatement, and the fact
   *    that we could have DERIVED a cause is not a reason to overrule a person
   *    who told us a different one.
   * 2. **The token type.** With no answer, a holding whose performance arrives
   *    through a fetched price gets `flow`, because a quantity edit there is
   *    unambiguously one. `manualEditNeedsCause` is the rule and the reasoning.
   * 3. **What the user last said about THIS holding.** The remembered default,
   *    so the second month of a monthly savings update is one tap.
   *
   * When none of the three answers, this REFUSES rather than picking. That is
   * the whole point of the ticket: a delta whose cause we cannot establish has
   * three possible readings, two of them produce a wrong number, and both wrong
   * numbers are plausible rather than absurd. There is no safe default, so
   * there is no default.
   */
  resolveCause(args: {
    tokenTypeCode: string | null;
    requested?: ManualEditCause;
    remembered?: string | null;
  }): ManualEditCause | null {
    if (args.requested) return args.requested;
    // A token whose type we could not read is treated as ambiguous, not as
    // priced. "Could not find out" resolves to the conservative reading — the
    // one that asks — never to the convenient one.
    if (args.tokenTypeCode !== null && !manualEditNeedsCause(args.tokenTypeCode)) return 'flow';
    if (isManualEditCause(args.remembered)) return args.remembered;
    return null;
  }

  async record(
    input: ManualBalanceEditInput,
    transaction?: DatabaseTransaction
  ): Promise<ManualBalanceEditResult> {
    const { holding, cause, editedAt } = input;
    const delta = new Decimal(input.newBalance).sub(new Decimal(input.previousBalance));

    // The same floor the reconciler uses, imported rather than copied so the
    // two cannot drift: a diff this service calls rounding must be one the
    // reconciler also declines to synthesize an opening for.
    if (delta.abs().lte(DEFAULT_OPENING_EPSILON)) {
      return {
        cause,
        delta,
        kind: null,
        occurredAt: null,
        transactionId: null,
        fee: null,
        skipped: 'no-delta',
      };
    }

    if (cause === 'growth') {
      return {
        cause,
        delta,
        kind: null,
        occurredAt: null,
        transactionId: null,
        fee: null,
        skipped: 'growth-needs-no-row',
      };
    }

    const occurredAt =
      cause === 'correction'
        ? await this.supersededFigureEnteredAt(holding, editedAt, transaction)
        : input.occurredAt;

    const kind =
      cause === 'correction' ? 'correction' : delta.isPositive() ? 'deposit' : 'withdraw';

    // How much of this movement was a charge rather than a movement (SC-857).
    //
    // Only a negative `flow` can carry one: a `correction` restates a figure
    // that was never paid and a `growth` returned above without writing
    // anything, so honouring a fee on either would attach a charge to an event
    // that did not happen. A caller sending one there gets it dropped rather
    // than refused, because the two paths that pass this field only ever set
    // it beside a declared transfer's withdrawal.
    const fee = cause === 'flow' && delta.isNegative() ? (input.fee ?? null) : null;
    if (fee && !feeFitsMovement(fee, delta)) {
      throw new ManualEditFeeRefused(fee.toString(), delta.abs().toString());
    }

    const flowExternalId = manualEditExternalId(editedAt);
    // Carved OUT of the movement, never added beside it. The rows this writes
    // must sum to the delta the anchor moved by, or
    // `OpeningBalanceReconciliationService` — which computes
    // `holdings.balance - sum(real txs)` — synthesizes a phantom
    // `opening_balance` for the difference on this very holding.
    const movement = fee ? delta.add(fee) : delta;

    const written = await this.transactionRepository.bulkUpsert(
      [
        {
          userId: holding.userId,
          holdingId: holding.id,
          tokenId: holding.tokenId,
          kind,
          quantity: movement.toString(),
          occurredAt,
          source: cause === 'correction' ? MANUAL_EDIT_CORRECTION_SOURCE : MANUAL_EDIT_FLOW_SOURCE,
          // Keyed on the EDIT instant, not on the date the user gave. The
          // dedup key is (holding, source, external_id) and two genuine
          // deposits can share a date; the edit instant is what makes a
          // retried mutation collapse onto its own row and two real edits
          // stay two rows.
          externalId: flowExternalId,
          sourceMetadata: {
            cause,
            previousBalance: input.previousBalance,
            newBalance: input.newBalance,
            editedAt: editedAt.toISOString(),
            // Only meaningful for a flow, and its absence for a correction is
            // the record that the date came from the ledger rather than from
            // the person.
            ...(cause === 'flow' ? { userSuppliedDate: input.occurredAt.toISOString() } : {}),
          },
        },
        // The fee as its OWN ledger row, not `fee_quantity` on the one above.
        //
        // `fee_quantity` is a sidecar and nothing sums it — the same reason
        // `StatementTransactionIngester` gives, and the reason this follows
        // that ingester's shape down to the `:fee` key suffix. Balance-at-time
        // and the opening-balance reconciler add up `quantity` alone, so a fee
        // written into the sidecar would be visible in the CSV export and
        // absent from every figure that matters.
        //
        // It also makes the hand-entered record match the IMPORTED one. The
        // Airwallex importer already writes a -16.85 beside each incoming
        // 5,617.60, and a person reconciling by hand entered the net 5,600.75
        // — a one-to-two relation no pairwise matcher can express, and the
        // reason SC-858 refused to ship one. Two record-keepers describing one
        // movement the same way is what makes them comparable at all.
        ...(fee
          ? [
              {
                userId: holding.userId,
                holdingId: holding.id,
                tokenId: holding.tokenId,
                kind: 'fee' as const,
                quantity: fee.neg().toString(),
                // Same instant as the movement it was charged on. The ledger
                // is ordered by `occurred_at`, and a fee that sorts away from
                // the payment that incurred it reads as an unexplained charge.
                occurredAt,
                source: MANUAL_EDIT_FLOW_SOURCE,
                externalId: manualEditFeeExternalId(flowExternalId),
                sourceMetadata: {
                  cause,
                  editedAt: editedAt.toISOString(),
                  // Which row this was carved out of, in the data rather than
                  // only in the key, so a reader who has one row does not have
                  // to know the suffix convention to find the other.
                  feeForExternalId: flowExternalId,
                },
              },
            ]
          : []),
      ],
      transaction
    );

    // By key, never by index. `returning()` on a multi-row insert makes no
    // promise about order, and reading `rows[0]` as "the movement" would put
    // the transfer's group id on the fee the day Postgres returns them the
    // other way round.
    const movementRow = written.rows.find((row) => row.externalId === flowExternalId);
    const feeRow = fee
      ? written.rows.find((row) => row.externalId === manualEditFeeExternalId(flowExternalId))
      : undefined;

    logger.info(
      {
        holdingId: holding.id,
        cause,
        kind,
        delta: delta.toString(),
        movement: movement.toString(),
        fee: fee?.toString() ?? null,
        occurredAt: occurredAt.toISOString(),
      },
      'Synthesized transaction for manual balance edit'
    );

    return {
      cause,
      delta,
      kind,
      occurredAt,
      transactionId: movementRow?.id ?? null,
      fee: fee ? { transactionId: feeRow?.id ?? null, quantity: fee } : null,
      skipped: null,
    };
  }

  /**
   * The instant the figure now being corrected entered the record.
   *
   * The last observation strictly before this edit, plus one millisecond —
   * plus, so the correction sits AFTER the observation it supersedes and the
   * anchor walk therefore covers it for every later date. Without the offset a
   * correction stamped exactly on the observation would fall outside
   * `findTxsInRange`'s half-open `(at, anchor]` interval at that instant and
   * the restated interval would start one anchor late.
   *
   * Falls back to `holdings.lastUpdated` when the holding has no observation
   * before this edit — a holding created and immediately corrected. That is
   * the only other moment we can name, and naming the edit instant instead
   * would put the step on today, which is the thing this avoids.
   *
   * Bounded by `editedAt` rather than by the clock, so the caller MUST run
   * this before appending the edit's own observation. `UpdateHoldingUseCase`
   * does, in the same transaction; an explicit bound is what makes that
   * ordering assertable in a test rather than a race.
   */
  private async supersededFigureEnteredAt(
    holding: Pick<Holding, 'id' | 'lastUpdated'>,
    editedAt: Date,
    transaction?: DatabaseTransaction
  ): Promise<Date> {
    const previous = await this.observationRepository.findLatestAtOrBefore(
      holding.id,
      new Date(editedAt.getTime() - 1),
      transaction
    );
    const at = previous?.observedAt ?? holding.lastUpdated;
    return new Date(at.getTime() + 1);
  }
}
