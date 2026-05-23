import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { createComponentLogger } from '@scani/logging';
import { QueueClient } from '@scani/queue';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('use-case:delete-all-user-data');

@Service()
export class DeleteAllUserDataUseCase {
  async execute(userId: string): Promise<{ success: true }> {
    logger.warn({ userId }, 'User requested deletion of all data');

    // Captured outside the transaction so the post-commit BullMQ purge
    // can iterate them. The DB rows go via the tx; the queue rows are
    // in Redis and have to be cleaned separately. Doing the Redis
    // delete *after* the tx commits is intentional: if the tx rolls
    // back we don't want to leave the user with phantom-deleted job
    // payloads but live DB rows pointing at them.
    let purgedJobIds: string[] = [];

    await withTransaction(
      async (tx) => {
        // Delete in FK-safe order. Junction tables (holdingGroups,
        // accountGroups, vaultHoldings) cascade automatically from their
        // parent deletes.
        //
        // PnL / historical-balance tables — explicit deletes even though
        // accounts-delete would cascade-clean holding_transactions and
        // holding_balance_observations. Explicit keeps the row counts in
        // the audit log for user-visible "here's what we removed"
        // surfaces. `portfolio_value_daily` ONLY cascades on users.id;
        // because this flow wipes data without removing the user row, it
        // must be explicit or rows leak.
        const portfolioDailyDel = await tx
          .delete(schema.portfolioValueDaily)
          .where(eq(schema.portfolioValueDaily.userId, userId))
          .returning({ snapshotDate: schema.portfolioValueDaily.snapshotDate });

        const holdingTxDel = await tx
          .delete(schema.holdingTransactions)
          .where(eq(schema.holdingTransactions.userId, userId))
          .returning({ id: schema.holdingTransactions.id });

        const holdingObsDel = await tx
          .delete(schema.holdingBalanceObservations)
          .where(eq(schema.holdingBalanceObservations.userId, userId))
          .returning({ id: schema.holdingBalanceObservations.id });

        const holdingsDel = await tx
          .delete(schema.holdings)
          .where(eq(schema.holdings.userId, userId))
          .returning({ id: schema.holdings.id });

        // `holding_coverage` is keyed by (accountId, tokenId) and has no
        // userId. Its accountId FK is ON DELETE CASCADE, so the accounts
        // delete below cleans it automatically.
        const accountsDel = await tx
          .delete(schema.accounts)
          .where(eq(schema.accounts.userId, userId))
          .returning({ id: schema.accounts.id });

        const vaultsDel = await tx
          .delete(schema.vaults)
          .where(eq(schema.vaults.userId, userId))
          .returning({ id: schema.vaults.id });

        const groupsDel = await tx
          .delete(schema.groups)
          .where(eq(schema.groups.userId, userId))
          .returning({ id: schema.groups.id });

        const walletsDel = await tx
          .delete(schema.userWallets)
          .where(eq(schema.userWallets.userId, userId))
          .returning({ id: schema.userWallets.id });

        const credentialsDel = await tx
          .delete(schema.userIntegrationCredentials)
          .where(eq(schema.userIntegrationCredentials.userId, userId))
          .returning({ id: schema.userIntegrationCredentials.id });

        // Wipe the user's job history too. `users(id)` has ON DELETE
        // CASCADE over user_jobs, but this flow deletes *user data*
        // without removing the user row — so the cascade never fires
        // and stale job rows would linger in the /jobs page. Note: the
        // running `user-data-delete` job deletes its own row here; the
        // worker's post-handler markCompleted then becomes a no-op
        // UPDATE (zero rows affected), which is fine.
        const jobsDel = await tx
          .delete(schema.userJobs)
          .where(eq(schema.userJobs.userId, userId))
          .returning({ jobId: schema.userJobs.jobId });

        purgedJobIds = jobsDel.map((row) => row.jobId);

        logger.info(
          {
            userId,
            holdings: holdingsDel.length,
            holdingTransactions: holdingTxDel.length,
            holdingBalanceObservations: holdingObsDel.length,
            portfolioValueDaily: portfolioDailyDel.length,
            accounts: accountsDel.length,
            vaults: vaultsDel.length,
            groups: groupsDel.length,
            wallets: walletsDel.length,
            credentials: credentialsDel.length,
            jobs: jobsDel.length,
          },
          'All user data deleted successfully'
        );
      },
      { name: 'deleteAllUserData', timeout: 30000 }
    );

    // Purge the user's BullMQ job payloads from Redis. The DB-side
    // `user_jobs` rows are gone; without this step the job payloads
    // (which include wallet addresses, exchange names, sometimes the
    // file r2Key) linger in Redis until BullMQ's own cleanup window
    // ages them out. `queue.getJob(id)` returns null for ids that
    // were never enqueued (e.g. inline-completed jobs that never hit
    // BullMQ), so we treat missing as a no-op. Removing the currently-
    // executing self-delete job is fine: BullMQ marks it failed but
    // the user-facing delete has already happened.
    if (purgedJobIds.length > 0) {
      try {
        const queue = Container.get(QueueClient).get();
        let removed = 0;
        for (const jobId of purgedJobIds) {
          try {
            const job = await queue.getJob(jobId);
            if (job) {
              await job.remove();
              removed++;
            }
          } catch (err) {
            // One stuck job shouldn't block the rest of the purge —
            // log and continue. The remaining payload still rotates
            // out of Redis via BullMQ's standard cleanup.
            logger.warn(
              { userId, jobId, error: err instanceof Error ? err.message : String(err) },
              'Failed to remove BullMQ payload during user-data-delete (non-fatal)'
            );
          }
        }
        logger.info(
          { userId, totalJobIds: purgedJobIds.length, removed },
          'BullMQ payloads purged for deleted user'
        );
      } catch (err) {
        // QueueClient not configured — likely a test context where the
        // queue isn't wired. The DB delete already happened; surface
        // the issue but don't fail the use case.
        logger.warn(
          { userId, error: err instanceof Error ? err.message : String(err) },
          'QueueClient unavailable; skipping BullMQ payload purge'
        );
      }
    }

    return { success: true };
  }
}
