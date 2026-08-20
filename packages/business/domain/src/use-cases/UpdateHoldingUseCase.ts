import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { createComponentLogger } from '@scani/logging';
import { and, eq } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { HoldingService, VaultService } from '../services';

const logger = createComponentLogger('use-case:update-holding');

export interface UpdateHoldingInput {
  balance?: string;
  lastUpdated?: Date;
  isActive?: boolean;
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

  async execute(
    holdingId: string,
    data: UpdateHoldingInput,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<typeof schema.holdings.$inferSelect> {
    logger.debug({ userId, holdingId, data }, 'Updating holding');

    const run = async (tx: DatabaseTransaction) => {
      const updateData = {
        ...data,
        lastUpdated: data.lastUpdated || new Date(),
      };

      const [result] = await tx
        .update(schema.holdings)
        .set(updateData)
        .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, userId)))
        .returning();

      if (!result) {
        throw new Error('Holding not found');
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
