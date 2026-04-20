import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { IntegrationCredentialsService } from '@scani/domain/services';
import { createComponentLogger } from '@scani/logging';
import { JOB_NAMES } from '@scani/queue';
import type { Job, Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';

const logger = createComponentLogger('processor:reconcile-pending-credentials');

/**
 * Max reconciliation retries per row. After this many attempts, the row
 * is marked `failed` and not retried until an admin manually resets it
 * via the /services/credentials admin page.
 */
const MAX_RECONCILE_ATTEMPTS = 3;

/**
 * Rows younger than this cutoff are still "fresh" — the backend may still
 * be mid-enqueue. Only rows that have been pending longer than this are
 * considered orphaned.
 */
const PENDING_CUTOFF_MS = 5 * 60 * 1000; // 5 min

/**
 * Build the reconciler processor. We need the queue so we can re-enqueue
 * directly (bypassing the backend's enqueue helper, which isn't accessible
 * from the worker process).
 */
export function buildReconcilePendingCredentialsProcessor(queue: Queue) {
  return async function processReconcilePendingCredentials(_job: Job): Promise<void> {
    const credentialsService = Container.get(IntegrationCredentialsService);

    const cutoff = new Date(Date.now() - PENDING_CUTOFF_MS);
    const orphans = await credentialsService.findPendingEnqueueOlderThan(cutoff);

    if (orphans.length === 0) {
      return;
    }

    logger.warn({ count: orphans.length }, '🔧 Reconciling orphaned credentials');

    for (const row of orphans) {
      // If we've already tried to reconcile this row too many times, give up.
      if (row.importRetryCount >= MAX_RECONCILE_ATTEMPTS) {
        await credentialsService.markImportFailed(
          row.id,
          `Reconciler gave up after ${MAX_RECONCILE_ATTEMPTS} attempts. ` +
            'Manual retry required via /services/credentials admin page.'
        );
        logger.error(
          { credentialsId: row.id, attempts: row.importRetryCount },
          '❌ Reconciler exhausted retries'
        );
        continue;
      }

      try {
        // Look up the institution name so we can populate the job payload.
        const [institution] = await db
          .select()
          .from(schema.institutions)
          .where(eq(schema.institutions.id, row.institutionId))
          .limit(1);

        if (!institution) {
          await credentialsService.markImportFailed(
            row.id,
            `Institution ${row.institutionId} no longer exists — cannot reconcile.`
          );
          continue;
        }

        // Synthesize a fresh requestId. A legitimate human-driven retry would
        // come with its own UUID, but the reconciler is firing on behalf of
        // a missing-in-action original, so a new UUID is the right shape.
        const requestId = crypto.randomUUID();

        // Build the exchange-import job id the same way apps/backend does
        // (enqueue.ts: `<name>_<userId>_<institutionId>_<requestId>`).
        const jobId = [JOB_NAMES.exchangeImport, row.userId, row.institutionId, requestId].join(
          '_'
        );

        await queue.add(
          JOB_NAMES.exchangeImport,
          {
            userId: row.userId,
            requestId,
            institutionId: row.institutionId,
            provider: institution.name,
          },
          {
            jobId,
            attempts: 3,
            backoff: { type: 'exponential', delay: 10_000 },
            removeOnComplete: 100,
            removeOnFail: 500,
          }
        );

        await credentialsService.markImportEnqueued(row.id, jobId);
        logger.info(
          { credentialsId: row.id, jobId, institution: institution.name },
          '✅ Orphaned credentials re-enqueued'
        );
      } catch (enqueueError) {
        const message = enqueueError instanceof Error ? enqueueError.message : String(enqueueError);
        await credentialsService.markImportFailed(row.id, message);
        logger.error(
          { credentialsId: row.id, error: message },
          '❌ Reconciler failed to re-enqueue'
        );
      }
    }
  };
}
