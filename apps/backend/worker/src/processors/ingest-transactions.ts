import { TransactionImportCoordinator, TransactionImportUnrecoverableError } from '@scani/domain';
import {
  PORTFOLIO_HISTORY_BACKFILL,
  TRANSACTION_IMPORT,
  type TransactionImportJob,
} from '@scani/jobs';
import {
  BullMqEnqueueService,
  type ProcessorContext,
  UnrecoverableError,
  UserJobProcessor,
} from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import { Container, Service } from 'typedi';

// Match the holdings router's coalesce — last tx-import in a wallet
// import wave (typically 4 EVM accounts running ~30s each) ends up
// enqueueing a single backfill that everyone falls behind on, since
// concurrent ones dedupe to the same jobId and the per-user advisory
// lock skips duplicates anyway.
const ROLLUP_COALESCE_WINDOW_MS = 30_000;

// Dispatches a single transaction-import to TransactionImportCoordinator,
// then kicks off downstream price-backfill + portfolio-rollup so the
// net-worth chart fills in once the tx ledger has new dates to price.
//
// One job per (account, source). Chain-enqueued from exchange-import /
// wallet-import after those complete, so user_jobs shows a row per
// account being imported — clear progress + failure isolation per account.
@Service()
export class IngestTransactionsProcessor extends UserJobProcessor<TransactionImportJob, unknown> {
  readonly descriptor = TRANSACTION_IMPORT;

  protected async handle(data: TransactionImportJob, _ctx: ProcessorContext): Promise<unknown> {
    const coordinator = Container.get(TransactionImportCoordinator);
    let result: Awaited<ReturnType<typeof coordinator.execute>>;
    try {
      result = await coordinator.execute({
        userId: data.userId,
        accountId: data.accountId,
        source: data.source,
        since: data.since ? new Date(data.since) : undefined,
      });
    } catch (error) {
      // Coordinator throws TransactionImportUnrecoverableError for
      // classified user-actionable failures. Bridge to BullMQ's
      // UnrecoverableError so the job skips the retry budget and shows
      // up in /jobs as failed with the original message.
      if (error instanceof TransactionImportUnrecoverableError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }

    // If the ingester actually produced rows, enqueue a per-user
    // history backfill. Coalesced to a 30s window so all 4 EVM
    // tx-imports kicked off from a single wallet-import confirm land
    // ONE backfill — and that backfill runs after the longest-running
    // tx-import finishes, so the rollup sees the full transaction
    // ledger. The per-user advisory lock inside the processor blocks
    // any concurrent runs.
    if (result.transactions > 0) {
      const bucket = Math.floor(Date.now() / ROLLUP_COALESCE_WINDOW_MS);
      try {
        await Container.get(BullMqEnqueueService).add(PORTFOLIO_HISTORY_BACKFILL, {
          userId: data.userId,
          requestId: `tx-import-${bucket}`,
          tokenIds: [],
          lookbackDays: 365,
        });
      } catch (error) {
        result.warnings.push(
          `Backfill enqueue failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      emitEntityChange({
        entityType: 'holding',
        operationType: 'sync',
        userId: data.userId,
        data: {
          reason: 'transaction_import',
          accountId: data.accountId,
          source: data.source,
          transactions: result.transactions,
        },
      });
    }

    return result;
  }
}
