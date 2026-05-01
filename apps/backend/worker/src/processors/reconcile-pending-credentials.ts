import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { IntegrationCredentialsService, WalletDiscoveryService } from '@scani/domain/services';
import { EXCHANGE_IMPORT, RECONCILE_PENDING_CREDENTIALS_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { BullMqEnqueueService, ScheduledJobProcessor } from '@scani/queue';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';

// Institution codes the providers registry uses for blockchain
// networks. Mirrors the catalog in WalletDiscoveryService /
// ImportExchangeAccountsUseCase. The reconciler skips re-enqueuing
// exchange-import for any institution that resolves to one of these —
// wallet-import is the right producer for those.
const BLOCKCHAIN_INSTITUTION_CODES = new Set([
  'ethereum',
  'bsc',
  'polygon',
  'avalanche',
  'arbitrum',
  'optimism',
  'base',
  'fantom',
  'cronos',
  'arbitrum-nova',
  'zksync-era',
  'scroll',
  'linea',
  'blast',
  'mantle',
  'opbnb',
  'gnosis',
  'celo',
  'moonbeam',
  'moonriver',
  'bitcoin',
  'solana',
  'tron',
  'ton',
]);

const logger = createComponentLogger('processor:reconcile-pending-credentials');

const MAX_RECONCILE_ATTEMPTS = 3;
const PENDING_CUTOFF_MS = 5 * 60 * 1000; // 5 min

@Service()
export class ReconcilePendingCredentialsProcessor extends ScheduledJobProcessor {
  readonly descriptor = RECONCILE_PENDING_CREDENTIALS_SCHEDULE;

  protected async handle(): Promise<void> {
    const credentialsService = Container.get(IntegrationCredentialsService);
    const walletDiscovery = Container.get(WalletDiscoveryService);
    const enqueueService = Container.get(BullMqEnqueueService);

    const cutoff = new Date(Date.now() - PENDING_CUTOFF_MS);
    const orphans = await credentialsService.findPendingEnqueueOlderThan(cutoff);
    if (orphans.length === 0) return;

    logger.warn({ count: orphans.length }, '🔧 Reconciling orphaned credentials');

    for (const row of orphans) {
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

        // Don't enqueue exchange-import for blockchain-typed institutions
        // — wallet-import is the right producer (different payload shape).
        const institutionCode = await walletDiscovery.resolveInstitutionCode(row.institutionId);
        if (institutionCode && BLOCKCHAIN_INSTITUTION_CODES.has(institutionCode)) {
          await credentialsService.markImportFailed(
            row.id,
            "Blockchain-type credentials cannot be reconciled via exchange-import. Re-trigger the wallet-import flow from the institution's page."
          );
          logger.warn(
            { credentialsId: row.id, institution: institution.name, institutionCode },
            '⏭️  Skipped reconcile for blockchain-type institution'
          );
          continue;
        }

        // Synthesize a fresh requestId — the original is gone. The
        // reconciler is firing on behalf of a missing-in-action enqueue.
        const requestId = crypto.randomUUID();
        const jobId = await enqueueService.add(EXCHANGE_IMPORT, {
          userId: row.userId,
          requestId,
          institutionId: row.institutionId,
          provider: institution.name,
        });

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
  }
}
