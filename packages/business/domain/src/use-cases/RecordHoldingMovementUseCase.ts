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
import { HoldingRepository } from '../repositories/HoldingRepository';
import { BalanceSyncOwnershipService } from '../services/accounts/BalanceSyncOwnershipService';
import { MANUAL_EDIT_FLOW_SOURCE } from '../services/holdings/ManualBalanceEditService';
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
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly updateHolding = Container.get(UpdateHoldingUseCase);
  private readonly linkTransferPairs = Container.get(LinkTransferPairsUseCase);
  private readonly syncOwnership = Container.get(BalanceSyncOwnershipService);

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

      const after = await this.applyFlow(
        source,
        amount.neg(),
        occurredAt,
        editedAt,
        userId,
        tx,
        input.direction === 'outflow' ? { decision: input.destination } : undefined
      );

      if (input.direction === 'outflow') return this.result(after, null, null);

      const destination = await this.destinationHolding(input, source, userId, tx);
      if (destination.id === source.id) throw new MovementSameHoldingError(source.id);

      const arrived = await this.applyFlow(destination, amount, occurredAt, editedAt, userId, tx);

      const transferGroupId = await this.linkTransferPairs.linkDeclaredPair(
        {
          outflow: this.legKey(source.id, editedAt),
          inflow: this.legKey(destination.id, editedAt),
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
    editOutflow?: ManualOutflowAnswer
  ): Promise<typeof schema.holdings.$inferSelect> {
    return await this.updateHolding.execute(
      holding.id,
      {
        balance: new Decimal(holding.balance).add(delta).toString(),
        editCause: 'flow',
        editOccurredAt: occurredAt,
        editedAt,
        ...(editOutflow ? { editOutflow } : {}),
      },
      userId,
      tx
    );
  }

  /**
   * The destination holding, found or created.
   *
   * Created at zero and then moved by the ordinary flow above, rather than
   * opened at the amount — one code path for "the account already held some"
   * and "it did not", so the arrival is a ledger row in both cases and
   * reconstruction before the transfer date reads zero rather than reading the
   * arrival twice.
   *
   * The `source` a created row opens under is `BalanceSyncOwnershipService`'s
   * answer and not a constant (SC-356). A row opened `manual` inside a
   * sync-owned account is one `HoldingsSyncHelper` may never correct, and the
   * next sync then creates a SECOND holding for the same (account, token) —
   * the split shape where per-holding dedup lets one upstream event land
   * twice.
   */
  private async destinationHolding(
    input: Extract<RecordHoldingMovementInput, { direction: 'transfer' }>,
    source: { id: string; tokenId: string },
    userId: string,
    tx: DatabaseTransaction
  ): Promise<{ id: string; balance: string }> {
    if (input.destinationHoldingId) {
      const chosen = await this.ownedHolding(input.destinationHoldingId, userId, tx);
      if (!chosen) throw new MovementHoldingNotFoundError(input.destinationHoldingId);
      return chosen;
    }

    const existing = await this.holdingRepository.findByAccountAndToken(
      input.destinationAccountId,
      source.tokenId,
      userId,
      source.id,
      tx
    );
    if (existing) return existing;

    const [account] = await tx
      .select({
        id: schema.accounts.id,
        userId: schema.accounts.userId,
        institutionId: schema.accounts.institutionId,
        metadata: schema.accounts.metadata,
        isActive: schema.accounts.isActive,
      })
      .from(schema.accounts)
      .where(
        and(eq(schema.accounts.id, input.destinationAccountId), eq(schema.accounts.userId, userId))
      )
      .limit(1);
    if (!account) throw new MovementHoldingNotFoundError(input.destinationAccountId);

    const syncSource = await this.syncOwnership.resolveSyncSource(account, tx);
    const [created] = await tx
      .insert(schema.holdings)
      .values({
        userId,
        accountId: account.id,
        tokenId: source.tokenId,
        balance: '0',
        source: syncSource ?? 'manual',
        // The owner named this account as where their money went. That is
        // exactly what `user_confirmed` claims, and it is true on either
        // branch above — only who owns the balance differs.
        arrival: 'user_confirmed',
      })
      .returning();
    if (!created) throw new MovementHoldingNotFoundError(input.destinationAccountId);
    return created;
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

  /** The natural key `ManualBalanceEditService` wrote this leg under. */
  private legKey(
    holdingId: string,
    editedAt: Date
  ): { holdingId: string; source: string; externalId: string } {
    return {
      holdingId,
      source: MANUAL_EDIT_FLOW_SOURCE,
      externalId: `manual-edit:${editedAt.toISOString()}`,
    };
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
