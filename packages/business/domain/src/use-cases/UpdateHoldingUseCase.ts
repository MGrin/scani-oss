import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { createComponentLogger } from '@scani/logging';
import {
  collidingHoldingTokens,
  type ManualEditCause,
  type ManualOutflowAnswer,
} from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { HoldingService, VaultService } from '../services';
import { ManualBalanceEditService } from '../services/holdings/ManualBalanceEditService';
import { TransferReviewService } from '../services/TransferReviewService';

const logger = createComponentLogger('use-case:update-holding');

/**
 * A rename that would leave two rows in one account reading identically.
 *
 * Separate from `DuplicateHoldingTokenError` because the sentence a reader
 * needs is different — that one says "this payload creates a second RUB row",
 * this one says "another RUB row here is already called Savings". The RULE is
 * not duplicated: both go through `collidingHoldingTokens` in `@scani/shared`,
 * which is the thing that must never drift.
 */
export class HoldingLabelTakenError extends Error {
  constructor(
    readonly label: string,
    readonly holdingId: string
  ) {
    super(`Another holding for this token in the same account is already called "${label}"`);
    this.name = 'HoldingLabelTakenError';
  }
}

/**
 * The destination a balance edit named could not be answered onto (SC-606).
 *
 * Raised rather than swallowed, and it rolls the whole edit back. The
 * alternative — commit the balance and drop the answer — leaves a `withdraw`
 * sitting in the transfer-review queue, which is precisely the second prompt
 * this ticket exists to remove, arriving on the one path where the user did
 * everything right.
 */
export class ManualOutflowAnswerRefused extends Error {
  constructor(readonly reason: string) {
    super(`The destination for this balance change could not be recorded: ${reason}`);
    this.name = 'ManualOutflowAnswerRefused';
  }
}

export interface UpdateHoldingInput {
  balance?: string;
  lastUpdated?: Date;
  isActive?: boolean;
  /**
   * What the user calls this pot (SC-330), on a holding that already exists
   * (SC-564).
   *
   * `undefined` leaves the name alone; `null` or `''` clears it. Everything
   * else is stored trimmed, because the position key trims and a name that
   * keys one way and displays another is two names.
   *
   * Deliberately NOT routed through `ManualBalanceEditService`: naming a pot
   * is not a claim about its balance. See the guard in `run` below.
   */
  label?: string | null;
  /**
   * What the balance edit MEANT (SC-510). Resolved by the caller — derived
   * for a holding whose token type carries its own price channel, answered by
   * the user otherwise. Absent means "do not synthesize", which is what an
   * `isActive` toggle and every pre-SC-510 caller are.
   */
  editCause?: ManualEditCause;
  /**
   * When a `flow` actually happened, per the user. Ignored for the other two
   * causes and defaulted to the edit instant when omitted.
   */
  editOccurredAt?: Date;
  /**
   * The instant of the EDIT, as opposed to of the money moving (SC-607).
   *
   * Defaulted to now, which is what every caller before this wanted. It is
   * settable because `ManualBalanceEditService` builds the synthesized row's
   * dedup key from it — `manual-edit:<iso>` — so a caller that supplies it can
   * address the row afterwards by its natural key, and two legs written under
   * one instant collapse onto their own rows when a submission is retried.
   *
   * `RecordHoldingMovementUseCase` is the only caller that supplies one: it
   * links a declared transfer's two legs afterwards, and addresses them by the
   * key this instant produces.
   */
  editedAt?: Date;
  /**
   * Where the money went, for a `flow` that takes the balance DOWN (SC-606).
   *
   * Settled in the same transaction as the `withdraw` it describes, so the row
   * is never visible unanswered. Absent means "leave it for the queue", which
   * is what every caller written before this did.
   */
  editOutflow?: ManualOutflowAnswer;
}

/**
 * The only path a user can edit a MANUAL holding's balance through — the
 * app's "edit the balance directly" flow, via `holdings.update`.
 *
 * It writes `holdings` itself rather than going through `HoldingService`,
 * and that is deliberate: the write is scoped by `userId` as well as
 * `holdingId`, which is the ownership check, and
 * `HoldingService.updateHoldingBalance` keys on `holdingId` alone. Routing
 * through the service would either drop that scoping or duplicate it.
 *
 * What was NOT deliberate is that it therefore skipped the sync-capture
 * observation `HoldingService` appends on every other balance mutation.
 * Every manual balance edit any user ever made is missing from
 * `holding_balance_observations` — five holdings and 29,746.55 of drift on
 * production when it was found, against zero across all 65 synced holdings
 * (SC-245).
 *
 * That is worse than a bookkeeping gap because of how the trail is read:
 * `BalanceAtTimeService` anchors a past-date balance on the nearest
 * observation before or after, and reports full confidence whenever it
 * finds one. A missing observation does not degrade the answer, it
 * produces a confident wrong one — into historical PnL and both exports.
 *
 * The `options.baseCurrencyId` parameter is gone. It gated a block that
 * SELECTed the token and the account and then only logged *"Created
 * holding_update portfolio event"* — a message about an event no code
 * emitted, its own comment admitting the wiring "never landed". Two
 * queries per balance edit to log something untrue.
 */
@Service()
export class UpdateHoldingUseCase {
  private readonly vaultService = Container.get(VaultService);
  private readonly holdingService = Container.get(HoldingService);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly manualBalanceEditService = Container.get(ManualBalanceEditService);
  private readonly transferReviews = Container.get(TransferReviewService);

  /**
   * Refuse a rename that would make two rows in one account read identically.
   *
   * The rule is `collidingHoldingTokens`, not a second copy of it: the review
   * screen, the create use case and this all have to refuse the same thing,
   * and the direction two implementations drift in is a form that submits and
   * then fails.
   *
   * **Only a non-empty name is guarded, and that is not laziness.** Clearing a
   * name returns the row to the unnamed population it came from, which is an
   * ambiguity that already exists rather than a new one — production holds four
   * unnamed RUB rows in one account today. Guarding the empty string would key
   * every one of them to the same position and refuse the fifth, which is the
   * exact trap `collidingHoldingTokens` documents avoiding on the create side:
   * a user who names one pot could then never un-name it, and would be stuck
   * in a state their own edit created. So this guard stays meaningful for as
   * long as naming is the act that distinguishes, which is the premise the
   * whole feature rests on — if a future change ever makes the empty string
   * distinguishing, this comment is what has to be argued with first.
   *
   * Compared against the account's other UNSYNCED rows for the token, matching
   * `findUnsyncedByAccountAndTokens`: an importer owns its own row and
   * overwrites it every sync, so a hand-named pot beside a synced one is two
   * positions rather than one duplicated (the Airwallex shape).
   */
  private async refuseIfLabelTaken(
    label: string,
    holdingId: string,
    previous: { accountId: string; tokenId: string },
    userId: string,
    tx: DatabaseTransaction
  ): Promise<void> {
    const siblings = await this.holdingRepository.findUnsyncedByAccountAndTokens(
      previous.accountId,
      [previous.tokenId],
      userId,
      tx
    );
    const taken = collidingHoldingTokens(
      [{ tokenId: previous.tokenId, label }],
      // Excluding itself, or renaming a pot to the name it already has would
      // collide with its own row and refuse a no-op.
      siblings.filter((row) => row.id !== holdingId)
    );
    if (taken.size > 0) {
      throw new HoldingLabelTakenError(label, holdingId);
    }
  }

  async execute(
    holdingId: string,
    data: UpdateHoldingInput,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<typeof schema.holdings.$inferSelect> {
    logger.debug({ userId, holdingId, data }, 'Updating holding');

    const run = async (tx: DatabaseTransaction) => {
      const {
        editCause,
        editOccurredAt,
        editedAt: requestedEditedAt,
        editOutflow,
        label: requestedLabel,
        ...columns
      } = data;
      const editedAt = requestedEditedAt ?? new Date();

      // Read BEFORE the update, in the same transaction, because the delta a
      // synthesized transaction has to explain is `new - previous` and the
      // previous value is gone the moment the UPDATE lands. Scoped by userId
      // like the update itself, so a mismatched owner reads nothing rather
      // than leaking a balance.
      const [previous] = await tx
        .select({
          balance: schema.holdings.balance,
          lastUpdated: schema.holdings.lastUpdated,
          accountId: schema.holdings.accountId,
          tokenId: schema.holdings.tokenId,
        })
        .from(schema.holdings)
        .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, userId)))
        .limit(1);

      // Empty is not a name, it is the absence of one, and the position key
      // already treats it that way — same normalisation the create path
      // applies, so a row named through either arrives identically.
      const label =
        requestedLabel === undefined
          ? undefined
          : requestedLabel?.trim()
            ? requestedLabel.trim()
            : null;

      if (label && previous) {
        await this.refuseIfLabelTaken(label, holdingId, previous, userId, tx);
      }

      // `lastUpdated` answers "when did this balance last move" — the sync
      // path deliberately skips writing it when a poll returns an unchanged
      // balance, so `MAX(last_updated)` means the last real move rather than
      // the last attempt. A rename is not a move: bumping it here would put a
      // fresh timestamp under a figure nobody re-checked, on exactly the rows
      // (four pots for one token) where the reader is already unsure which
      // number belongs to what.
      const claimsTheBalanceMoved = data.balance !== undefined || data.isActive !== undefined;

      const updateData = {
        ...columns,
        ...(label === undefined ? {} : { label }),
        ...(data.lastUpdated || claimsTheBalanceMoved
          ? { lastUpdated: data.lastUpdated || editedAt }
          : {}),
        // Remember the answer as this holding's default for next time, and
        // only when a human could have given one. A derived cause on a priced
        // holding is re-derived every time and would only put a misleading
        // pre-selection on a control the user never sees.
        ...(editCause ? { manualEditCause: editCause } : {}),
      };

      const [result] = await tx
        .update(schema.holdings)
        .set(updateData)
        .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, userId)))
        .returning();

      if (!result) {
        throw new Error('Holding not found');
      }

      // Before the observation below, not after: a `correction` is dated at
      // the moment the figure it supersedes entered the record, and that is
      // the LAST observation before this edit. Appending this edit's own
      // observation first would make the correction supersede itself and
      // restate an interval one millisecond long.
      const written =
        data.balance !== undefined && editCause && previous
          ? await this.manualBalanceEditService.record(
              {
                holding: result,
                previousBalance: previous.balance,
                newBalance: result.balance,
                cause: editCause,
                occurredAt: editOccurredAt ?? editedAt,
                editedAt,
              },
              tx
            )
          : null;

      // Where it went, settled onto the row that was just written and in the
      // same transaction (SC-606).
      //
      // Answering the queue's question here is the whole point: without it the
      // `withdraw` this edit synthesized is an unanswered outflow, so the act
      // of explaining the balance change is what puts the next question in
      // front of the person who just explained it.
      //
      // Guarded on the KIND rather than on the caller's word: `record`
      // synthesizes a `withdraw` only for a negative `flow`, and a destination
      // arriving beside a `correction`, a `growth` or a deposit has no outflow
      // to describe. Refusing loudly rather than ignoring it, because a client
      // that sends one has a bug and silently dropping the field would leave
      // the user believing they answered.
      if (editOutflow) {
        if (written?.kind !== 'withdraw' || written.transactionId === null) {
          throw new ManualOutflowAnswerRefused(
            `this edit wrote ${written?.kind ?? 'no'} row, and a destination describes a withdrawal`
          );
        }
        const settled = await this.transferReviews.resolve(
          userId,
          written.transactionId,
          editOutflow.decision,
          {
            ...(editOutflow.destination ? { destination: editOutflow.destination } : {}),
            transaction: tx,
          }
        );
        if (!settled.ok) throw new ManualOutflowAnswerRefused(settled.reason);
      }

      // In the same transaction as the write it describes, and only when
      // the balance actually moved — an `isActive` toggle is not a balance
      // observation. `result` is the row the update returned, so this costs
      // no extra read.
      if (data.balance !== undefined) {
        await this.holdingService.recordBalanceObservation(
          result,
          tx,
          { origin: 'updateHolding' },
          // The person said what this change was, so the interval closing on
          // this observation is answered and the balance-gap queue must not
          // ask again (SC-606).
          //
          // This is NOT what `BalanceGapService`'s `owner-stated` suppression
          // does, and the difference is why the third prompt existed. That one
          // tests `source !== 'sync-capture'`, and every observation this
          // service writes — a manual edit's included — carries
          // `sync-capture`, so it has never fired on this path however
          // confidently its docblock says SC-510 already asked.
          //
          // What actually left the gap open was the DATE. A `flow` is stamped
          // at the day the user gave; the client pre-fills today, a date-only
          // value becomes LOCAL midnight, and in any zone east of UTC that
          // instant is yesterday — so the row lands outside `(previous
          // observation, this one]` and stops explaining the very interval it
          // was written for. Measured 2026-08-25 on a UTC+12 box: an
          // observation 12h old gave three prompts, one 72h old gave two, with
          // nothing else changed.
          //
          // Stamping the cause rather than suppressing the row keeps the
          // answer readable: the observation says a person called this a flow,
          // in the vocabulary the queue itself writes.
          editCause ? { answer: editCause, at: editedAt } : undefined
        );
      }

      logger.info(
        {
          holdingId: result.id,
          accountId: result.accountId,
          tokenId: result.tokenId,
          balance: result.balance,
        },
        'Holding updated successfully'
      );

      return result;
    };

    // An explicit transaction makes this composable into a larger unit of
    // work, which is what lets the observation be asserted under the
    // rollback-per-test helper rather than against a live database.
    const updatedHolding = transaction
      ? await run(transaction)
      : await withTransaction(run, { name: 'update-holding', timeout: 10000 });

    try {
      await this.vaultService.recalculateVaultsForHolding(holdingId);
    } catch (vaultError) {
      logger.warn(
        { holdingId, error: vaultError },
        'Failed to recalculate vaults after holding update'
      );
    }

    return updatedHolding;
  }
}
