import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { createComponentLogger } from '@scani/logging';
import type {
  ManualOutflowAnswer,
  RecordHoldingMovementInput,
  RecordHoldingMovementResult,
} from '@scani/shared';
import Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { DeclaredTransferService } from '../services/holdings/DeclaredTransferService';
import { manualEditFlowLeg } from '../services/holdings/ManualBalanceEditService';
import { LinkTransferPairsUseCase } from './LinkTransferPairsUseCase';
import { UpdateHoldingUseCase } from './UpdateHoldingUseCase';

const logger = createComponentLogger('use-case:record-holding-movement');

/** The holding named by the request is gone, hidden, or somebody else's. */
export class MovementHoldingNotFoundError extends Error {
  constructor(readonly holdingId: string) {
    super('Holding not found');
    this.name = 'MovementHoldingNotFoundError';
  }
}

/** A transfer whose two legs are one holding moves nothing. */
export class MovementSameHoldingError extends Error {
  constructor(readonly holdingId: string) {
    super('A transfer must have two different holdings');
    this.name = 'MovementSameHoldingError';
  }
}

/** An outflow larger than the balance would leave a manual holding negative. */
export class MovementExceedsBalanceError extends Error {
  constructor(
    readonly balance: string,
    readonly amount: string
  ) {
    super(`Cannot move ${amount} out of a holding that holds ${balance}`);
    this.name = 'MovementExceedsBalanceError';
  }
}

/**
 * "I withdrew 2000" — recorded as the movement it is (SC-607).
 *
 * ## What this is, in one sentence
 *
 * The inverse of the balance editor. That one takes the balance the owner
 * computed and infers the movement; this takes the movement the owner knows
 * and computes the balance.
 *
 * ## Why it writes nothing itself
 *
 * Every leg goes through `UpdateHoldingUseCase` with `editCause: 'flow'`, so
 * this class owns arithmetic and ordering and owns no ledger semantics at all.
 * That is deliberate and it is the difference between this and a second
 * writer:
 *
 * - `ManualBalanceEditService` decides the row's kind, source, dedup key and
 *   date, and `flowRoleOf` then nets it out of return — so a recorded flow is
 *   indistinguishable from the same flow reached through the balance editor,
 *   which is correct, because it IS the same event.
 * - The ownership-scoped update, the `holding_balance_observations` row and
 *   the vault recalculation come along for free. A movement path with its own
 *   `UPDATE holdings SET balance` would have re-created SC-245 — five holdings
 *   and 29,746.55 of drift missing from the observation trail — on a brand new
 *   surface.
 *
 * The one thing it adds is that `holdings.balance` is an ANCHOR, not a sum:
 * inserting a past transaction does not move today's figure. So each leg must
 * state the resulting balance explicitly, and both legs of a transfer must do
 * it, or the destination reads short by the amount that arrived.
 *
 * ## Why an outflow carries an answer
 *
 * A `withdraw` with no `transfer_review` is the transfer-review queue's
 * definition of a pending row (`pendingPredicate`), so recording one without
 * an answer would move a prompt rather than remove one.
 *
 * The answer travels as `editOutflow` through `UpdateHoldingUseCase`, which is
 * SC-606's path and settles it via `TransferReviewService.resolve` in the same
 * transaction. That is deliberate rather than incidental: `resolve` is where
 * the queue's own refusals live — a `left_control` naming a destination in the
 * owner's own wallets is refused there (SC-350), and a raw UPDATE on
 * `transfer_review` would write exactly the answer the queue exists to
 * prevent, while looking identical in the database.
 *
 * ## Why a transfer does not go through the matcher's heuristic
 *
 * `LinkTransferPairsUseCase.linkDeclaredPair` writes the shared group id for
 * two rows this class just created. It does NOT run `execute`, whose ±1% and
 * ±30-minute tolerances exist to guess at pairs nobody stated: re-deriving a
 * pair we were told about would let a coincidental third row win it, and would
 * leave the transfer unlinked whenever a second movement of the same size sat
 * inside half an hour of it. A declared pair is not a discovery.
 */
@Service()
export class RecordHoldingMovementUseCase {
  private readonly updateHolding = Container.get(UpdateHoldingUseCase);
  private readonly linkTransferPairs = Container.get(LinkTransferPairsUseCase);
  private readonly declaredTransfers = Container.get(DeclaredTransferService);

  /**
   * `transaction` is accepted for the same reason `UpdateHoldingUseCase`
   * accepts one: without it this opens its own via `withTransaction` and
   * nothing a test could roll back would contain it, so the assertions would
   * have to run against a live database instead of under `withTestDb`.
   */
  async execute(
    input: RecordHoldingMovementInput,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<RecordHoldingMovementResult> {
    const amount = new Decimal(input.amount);
    const occurredAt = new Date(input.occurredAt);

    const run = async (tx: DatabaseTransaction) => {
      const source = await this.ownedHolding(input.holdingId, userId, tx);
      if (!source) throw new MovementHoldingNotFoundError(input.holdingId);

      // One instant for the whole movement. `ManualBalanceEditService` keys
      // its dedup id on this, so both legs of a transfer share a key and a
      // retried submission collapses onto the two rows it already wrote
      // instead of doubling the money.
      const editedAt = new Date();

      if (input.direction === 'inflow') {
        const after = await this.applyFlow(source, amount, occurredAt, editedAt, userId, tx);
        return this.result(after, null, null);
      }

      const remaining = new Decimal(source.balance).sub(amount);
      if (remaining.isNegative()) {
        throw new MovementExceedsBalanceError(source.balance, input.amount);
      }

      // What the rail kept (SC-889). `amount` is what LEFT — the figure on the
      // owner's statement — so the source anchor falls by all of it and the
      // fee is carved out of the withdrawal rather than added beside it.
      const fee =
        input.direction === 'transfer' && input.feeQuantity ? new Decimal(input.feeQuantity) : null;

      const after = await this.applyFlow(source, amount.neg(), occurredAt, editedAt, userId, tx, {
        ...(input.direction === 'outflow' ? { editOutflow: { decision: input.destination } } : {}),
        ...(fee ? { fee } : {}),
      });

      if (input.direction === 'outflow') return this.result(after, null, null);

      const destination = await this.destinationHolding(input, source, userId, tx);
      if (destination.id === source.id) throw new MovementSameHoldingError(source.id);

      // What ARRIVED. Computed from this use case's own input rather than read
      // back off the withdrawal — which is where `UpdateHoldingUseCase` gets
      // it, and the difference is worth stating. `record` DROPS a fee it will
      // not honour on a `correction` or a `growth`, and that path's caller has
      // to allow for it; here the leg above is a `flow` whose delta is
      // `-amount` with `amount` positive by schema, so the drop is
      // unreachable and the only other outcome is `ManualEditFeeRefused`
      // rolling the whole transaction back. Honoured or nothing was written.
      const arrived = await this.applyFlow(
        destination,
        fee ? amount.sub(fee) : amount,
        occurredAt,
        editedAt,
        userId,
        tx
      );

      const transferGroupId = await this.linkTransferPairs.linkDeclaredPair(
        {
          outflow: manualEditFlowLeg(source.id, editedAt),
          inflow: manualEditFlowLeg(destination.id, editedAt),
          userId,
        },
        tx
      );

      logger.info(
        {
          userId,
          holdingId: source.id,
          destinationHoldingId: destination.id,
          amount: input.amount,
          transferGroupId,
        },
        'Recorded a declared transfer'
      );

      return this.result(after, arrived, transferGroupId);
    };

    return transaction
      ? await run(transaction)
      : await withTransaction(run, { name: 'record-holding-movement', timeout: 15000 });
  }

  /**
   * One leg: move the anchor by `delta` and let `ManualBalanceEditService`
   * write the row that explains it.
   *
   * `editedAt` is passed in rather than defaulted so the caller can address
   * the synthesized row afterwards by its natural key — the only reason the
   * parameter exists.
   */
  private async applyFlow(
    holding: { id: string; balance: string },
    delta: Decimal,
    occurredAt: Date,
    editedAt: Date,
    userId: string,
    tx: DatabaseTransaction,
    /**
     * What this leg MEANT, for the legs that mean something beyond their own
     * arithmetic. One object rather than two trailing positionals so the two
     * calls that pass neither stay six arguments long.
     */
    meaning?: { editOutflow?: ManualOutflowAnswer; fee?: Decimal }
  ): Promise<typeof schema.holdings.$inferSelect> {
    return await this.updateHolding.execute(
      holding.id,
      {
        balance: new Decimal(holding.balance).add(delta).toString(),
        editCause: 'flow',
        editOccurredAt: occurredAt,
        editedAt,
        ...(meaning?.editOutflow ? { editOutflow: meaning.editOutflow } : {}),
        // `editFee` rather than `editOutflow.feeQuantity`: a transfer declared
        // here is answered `paired` by `linkDeclaredPair`, never `internal`,
        // so there is no answer object for a fee to travel in (SC-889).
        ...(meaning?.fee ? { editFee: meaning.fee } : {}),
      },
      userId,
      tx
    );
  }

  /**
   * The destination holding, found or created — resolved by
   * `DeclaredTransferService`, which is the one place a DECLARED transfer's
   * arrival is located (SC-614).
   *
   * Shared with `UpdateHoldingUseCase`, whose `internal` answer is the same
   * act reached from the balance editor. Both must open a created row the same
   * way — at zero under `BalanceSyncOwnershipService`'s source rather than
   * `manual` at the amount (SC-356) — and both must refuse a destination that
   * has gone. Two implementations of that would be free to disagree, and the
   * disagreement renders as money arriving in a holding no sync may ever
   * correct.
   *
   * `null` becomes this use case's own error rather than the balance editor's,
   * naming whichever of the two ids the request actually gave.
   */
  private async destinationHolding(
    input: Extract<RecordHoldingMovementInput, { direction: 'transfer' }>,
    source: { id: string; tokenId: string },
    userId: string,
    tx: DatabaseTransaction
  ): Promise<{ id: string; balance: string }> {
    const destination = await this.declaredTransfers.destinationHolding(
      {
        accountId: input.destinationAccountId,
        holdingId: input.destinationHoldingId ?? null,
      },
      source,
      userId,
      tx
    );
    if (!destination) {
      throw new MovementHoldingNotFoundError(
        input.destinationHoldingId ?? input.destinationAccountId
      );
    }
    return destination;
  }

  /**
   * A holding this user owns and can see.
   *
   * Scoped by `userId` in the WHERE rather than checked after the read, and
   * not `HoldingRepository.findByIdVisible`, which takes no owner — a
   * mismatched owner has to read as "not found" rather than as a balance the
   * caller then compares against.
   */
  private async ownedHolding(
    holdingId: string,
    userId: string,
    tx: DatabaseTransaction
  ): Promise<typeof schema.holdings.$inferSelect | null> {
    const [row] = await tx
      .select()
      .from(schema.holdings)
      .where(
        and(
          eq(schema.holdings.id, holdingId),
          eq(schema.holdings.userId, userId),
          eq(schema.holdings.isHidden, false)
        )
      )
      .limit(1);
    return row ?? null;
  }

  private result(
    holding: { id: string; balance: string },
    destination: { id: string; balance: string } | null,
    transferGroupId: string | null
  ): RecordHoldingMovementResult {
    return {
      holdingId: holding.id,
      balance: holding.balance,
      destinationHoldingId: destination?.id ?? null,
      destinationBalance: destination?.balance ?? null,
      transferGroupId,
    };
  }
}
