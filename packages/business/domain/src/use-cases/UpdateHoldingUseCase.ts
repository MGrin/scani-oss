import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { createComponentLogger } from '@scani/logging';
import { collidingHoldingTokens, type ManualEditCause } from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { HoldingService, VaultService } from '../services';
import { ManualBalanceEditService } from '../services/holdings/ManualBalanceEditService';

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
 ***REMOVED***
 ***REMOVED***
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
      const { editCause, editOccurredAt, label: requestedLabel, ...columns } = data;
      const editedAt = new Date();

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
      if (data.balance !== undefined && editCause && previous) {
        await this.manualBalanceEditService.record(
          {
            holding: result,
            previousBalance: previous.balance,
            newBalance: result.balance,
            cause: editCause,
            occurredAt: editOccurredAt ?? editedAt,
            editedAt,
          },
          tx
        );
      }

      // In the same transaction as the write it describes, and only when
      // the balance actually moved — an `isActive` toggle is not a balance
      // observation. `result` is the row the update returned, so this costs
      // no extra read.
      if (data.balance !== undefined) {
        await this.holdingService.recordBalanceObservation(result, tx, {
          origin: 'updateHolding',
        });
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
