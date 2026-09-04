import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { createComponentLogger } from '@scani/logging';
import { QueueClient } from '@scani/queue';
import { eq, getTableColumns } from 'drizzle-orm';
import { type AnyPgColumn, getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { Container, Service } from 'typedi';
import {
  USER_DATA_TABLE_DISPOSITIONS,
  USER_ROW_COLUMN_DISPOSITIONS,
} from './user-data-deletion-manifest';

const logger = createComponentLogger('use-case:delete-all-user-data');

/**
 * The TypeScript property name a drizzle column is reachable under, which is
 * what `.set()` keys on — `column.name` is the SQL name and silently updates
 * nothing when the two differ, which they do for every camel-cased column.
 */
function columnKey(table: PgTable, column: AnyPgColumn): string {
  const entry = Object.entries(getTableColumns(table)).find(([, col]) => col === column);
  if (!entry) throw new Error(`Column ${column.name} is not on ${getTableConfig(table).name}`);
  return entry[0];
}

@Service()
export class DeleteAllUserDataUseCase {
  async execute(userId: string): Promise<{ success: true }> {
    logger.warn({ userId }, 'User requested deletion of all data');

    // Captured inside the transaction, consumed after it commits. The DB rows
    // go via the tx; BullMQ payloads live in Redis and R2 objects live in
    // object storage, and neither can join a Postgres transaction. Doing both
    // *after* the commit is deliberate — see the purges at the bottom.
    const echoed = new Map<PgTable, string[]>();

    await withTransaction(
      async (tx) => {
        // Every table keyed on `users.id` is classified in the manifest, and
        // the loop is driven by it rather than by a hand-written list of
        // deletes. That is the whole point: this flow was correct when it was
        // written and silently wrong three months later, because a new table
        // is not a change to any file anyone re-reads (SC-1018). Junction
        // tables (holdingGroups, accountGroups, vaultHoldings,
        // holdingCoverage, documentExtractions, paymentOccurrences,
        // vendorAliases) carry no userId and cascade from their parents here.
        for (const entry of USER_DATA_TABLE_DISPOSITIONS) {
          if (entry.kind === 'keep') continue;

          if (entry.kind === 'anonymise') {
            await tx
              .update(entry.table)
              .set({ [columnKey(entry.table, entry.userColumn)]: null })
              .where(eq(entry.userColumn, userId));
            continue;
          }

          const removed = await tx
            .delete(entry.table)
            .where(eq(entry.userColumn, userId))
            .returning({ echo: entry.echo });
          echoed.set(
            entry.table,
            removed.map((row) => String(row.echo))
          );
        }

        // The user row survives on purpose — the account stays able to sign
        // in — so its own columns are the one thing the FK enumeration above
        // cannot reach. The manifest classifies them too; anything holding
        // content the user entered is cleared here.
        const cleared = USER_ROW_COLUMN_DISPOSITIONS.filter((c) => c.kind === 'clear');
        if (cleared.length > 0) {
          await tx
            .update(schema.users)
            .set(Object.fromEntries(cleared.map((c) => [columnKey(schema.users, c.column), null])))
            .where(eq(schema.users.id, userId));
        }

        logger.info(
          {
            userId,
            removed: Object.fromEntries(
              [...echoed].map(([table, rows]) => [getTableConfig(table).name, rows.length])
            ),
            clearedUserColumns: cleared.length,
          },
          'All user data deleted successfully'
        );
      },
      { name: 'deleteAllUserData', timeout: 30000 }
    );

    await this.purgeStoredObjects(userId, echoed.get(schema.documents) ?? []);
    await this.purgeQueuePayloads(userId, echoed.get(schema.userJobs) ?? []);

    return { success: true };
  }

  /**
   * Remove the R2 objects behind the documents just deleted — the bank
   * statements, screenshots and invoices, which are the most sensitive bytes
   * the product holds and outlived this flow entirely until SC-1014.
   *
   * **Objects go after the commit, and the failure this ordering picks is the
   * recoverable one.** An object delete cannot join a Postgres transaction.
   * Deleting objects first means a rollback leaves rows pointing at bytes that
   * are gone — dead pointers on a user whose data was NOT deleted, and nothing
   * can repair them. Deleting them after means a failed object delete leaves
   * bytes with no row, which is enumerable by prefix
   * (`documents/{userId}/{documentId}.{ext}`, `DocumentRetentionService:36`)
   * and logged with its key.
   *
   * `DocumentDeletionService` reaches the same order for a different reason
   * and is deliberately not reused: it runs its own connection outside this
   * transaction, and it REFUSES a document a settled payment occurrence
   * depends on — a refusal that is right one document at a time and wrong
   * here, where the payments were removed moments ago.
   */
  private async purgeStoredObjects(userId: string, r2Keys: string[]): Promise<void> {
    if (r2Keys.length === 0) return;
    let storage: StorageFacade;
    try {
      storage = Container.get(StorageFacade);
    } catch (err) {
      logger.error(
        { userId, objects: r2Keys.length, error: err instanceof Error ? err.message : String(err) },
        'Storage unavailable; document rows are deleted but their stored objects remain'
      );
      return;
    }

    let removed = 0;
    for (const key of r2Keys) {
      try {
        await storage.delete(key);
        removed++;
      } catch (err) {
        // One unreachable object must not strip the rest. It is logged with
        // its key because that is the only thing left that can find it.
        logger.warn(
          { userId, r2Key: key, error: err instanceof Error ? err.message : String(err) },
          'Document row deleted but its stored object could not be removed'
        );
      }
    }
    logger.info(
      { userId, objects: r2Keys.length, removed },
      'Stored objects purged for deleted user'
    );
  }

  /**
   * Purge the user's BullMQ job payloads from Redis. The `user_jobs` rows are
   * gone; without this the payloads (wallet addresses, exchange names,
   * sometimes a file's r2Key) linger until BullMQ's own cleanup ages them out.
   * `queue.getJob(id)` returns null for ids never enqueued (inline-completed
   * jobs), so missing is a no-op. Removing the currently-executing self-delete
   * job is fine: BullMQ marks it failed and the user-facing delete has already
   * happened.
   */
  private async purgeQueuePayloads(userId: string, jobIds: string[]): Promise<void> {
    if (jobIds.length === 0) return;
    try {
      const queue = Container.get(QueueClient).get();
      let removed = 0;
      for (const jobId of jobIds) {
        try {
          const job = await queue.getJob(jobId);
          if (job) {
            await job.remove();
            removed++;
          }
        } catch (err) {
          logger.warn(
            { userId, jobId, error: err instanceof Error ? err.message : String(err) },
            'Failed to remove BullMQ payload during user-data-delete (non-fatal)'
          );
        }
      }
      logger.info(
        { userId, totalJobIds: jobIds.length, removed },
        'BullMQ payloads purged for deleted user'
      );
    } catch (err) {
      // QueueClient not configured — likely a test context where the queue
      // isn't wired. The DB delete already happened; surface it, don't fail.
      logger.warn(
        { userId, error: err instanceof Error ? err.message : String(err) },
        'QueueClient unavailable; skipping BullMQ payload purge'
      );
    }
  }
}
