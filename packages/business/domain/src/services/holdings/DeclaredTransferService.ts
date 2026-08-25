import type { DatabaseTransaction } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import type { TransferDestinationRef } from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { BalanceSyncOwnershipService } from '../accounts/BalanceSyncOwnershipService';

/**
 * Where a transfer the OWNER declared arrives (SC-614).
 *
 * ## Why this is not `writeInflow`
 *
 * `TransferReviewService.writeInflow` answers the queue's question, and the
 * queue's outflow is historical: it came from an import, and whatever produced
 * the destination's balance already observed the arrival. Moving that anchor
 * would count the money twice, so `writeInflow` deliberately does not — it
 * inserts the arrival row and leaves `holdings.balance` alone on any holding
 * it did not create.
 *
 * A declared transfer is the opposite case. The owner is the only source of
 * truth for both sides and only one side has moved, so the arrival has to move
 * the destination's anchor or the money silently goes missing: the source
 * drops, the destination does not, and an arrival row sits against a figure
 * that never changed.
 *
 * Both requirements are real and they contradict. An intent flag on
 * `writeInflow` was rejected (mgrin, 2026-08-25) because one function with two
 * meanings makes every future caller reason correctly about which one it
 * wants, and both failures are silent. So the callers are split: the queue
 * keeps `writeInflow` unchanged, and everything the owner declares resolves
 * its destination here and then writes both legs as ordinary flows.
 *
 * ## What it does and does not do
 *
 * It resolves the destination HOLDING and nothing else — no ledger row, no
 * balance, no link. The two callers,
 * `RecordHoldingMovementUseCase` and `UpdateHoldingUseCase`, both move the
 * anchors through `UpdateHoldingUseCase` itself so that
 * `ManualBalanceEditService` keeps owning the row's kind, source, dedup key
 * and date, and the balance observation and vault recalculation come along
 * with it. A second writer with its own `UPDATE holdings SET balance` is what
 * SC-245 was.
 */
@Service()
export class DeclaredTransferService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly syncOwnership = Container.get(BalanceSyncOwnershipService);

  /**
   * The holding a declared transfer arrives in — named, found, or opened.
   *
   * `null` means the destination cannot be honoured: gone, hidden, somebody
   * else's, in another account, or tracking a different token. Returned rather
   * than thrown because the two callers owe their users different sentences —
   * one refuses a balance edit, the other a movement — and each maps this to
   * its own error.
   *
   * A named holding is re-validated here, inside the writing transaction,
   * against the token and account the caller actually has: the picker's list
   * is minutes old and a holding can be deleted, hidden or re-tokened in
   * between.
   *
   * **Opened at zero, never at the amount that moved.** The caller then moves
   * it by the ordinary flow, so there is one code path for "the account
   * already held some" and "it did not" and reconstruction before the transfer
   * date reads zero rather than reading the arrival twice. The `source` a
   * created row opens under is `BalanceSyncOwnershipService`'s answer and not
   * a constant (SC-356): a row opened `manual` inside a sync-owned account is
   * one `HoldingsSyncHelper` may never correct, and the next sync then creates
   * a SECOND holding for the same (account, token).
   */
  async destinationHolding(
    destination: TransferDestinationRef,
    source: { id: string; tokenId: string },
    userId: string,
    tx: DatabaseTransaction
  ): Promise<Holding | null> {
    if (destination.holdingId) {
      const [named] = await tx
        .select()
        .from(schema.holdings)
        .where(
          and(
            eq(schema.holdings.id, destination.holdingId),
            eq(schema.holdings.userId, userId),
            eq(schema.holdings.accountId, destination.accountId),
            eq(schema.holdings.tokenId, source.tokenId),
            eq(schema.holdings.isHidden, false)
          )
        )
        .limit(1);
      return named ?? null;
    }

    // "That account tracks no position in this token yet." Between the picker
    // rendering and this write one may have appeared — an import ran, another
    // tab created it — and using it is the honest resolution of that race: the
    // owner chose the account, and a second holding for the same token in it
    // would be a duplicate nobody asked for.
    const existing = await this.holdingRepository.findByAccountAndToken(
      destination.accountId,
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
      .where(and(eq(schema.accounts.id, destination.accountId), eq(schema.accounts.userId, userId)))
      .limit(1);
    if (!account) return null;

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
    return created ?? null;
  }
}
