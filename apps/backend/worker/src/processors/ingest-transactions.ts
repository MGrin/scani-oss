import { TransactionImportCoordinator, TransactionImportUnrecoverableError } from '@scani/domain';
import { FeedBatchRejected } from '@scani/domain/services';
import { TRANSACTION_IMPORT, type TransactionImportJob } from '@scani/jobs';
import { ProviderError } from '@scani/providers/core/errors';
import {
  type ProcessorContext,
  UnrecoverableError,
  UserJobProcessor,
  userFacing,
} from '@scani/queue';
import { Container, Service } from 'typedi';
import { afterLedgerRows } from '../lib/after-ledger-rows';
import { asJobFailure } from '../lib/request-refusal';

/**
 * The message to fail with when a provider has already told us retrying is
 * pointless, or null when the failure is worth another attempt (SC-166).
 *
 * `ProviderError.kind` exists precisely to carry this, and its own docblock
 * says `unrecoverable` and `auth-failed` mean "don't retry, surface to the
 * user" — but nothing on the transaction-import path read it. So a provider
 * rejecting a request as malformed was indistinguishable from a dropped
 * connection and spent the whole retry budget losing: Bybit answered
 * `retCode=131002` (a start/end span its endpoint will not serve) to the
 * same request three times per run, six runs across 2026-07-10..12 on
 * mgrin's account, and the only thing three attempts bought was three
 * identical rejections and six weeks of a portfolio quietly missing its
 * Bybit ledger.
 *
 * `rate-limited` and `retryable` stay retryable — those are what the budget
 * is for. `not-supported` cannot reach here; the coordinator checks
 * `hasProviderFor` before dispatching.
 *
 * Classifying here rather than in the coordinator keeps the domain service
 * free of BullMQ: what a failure *is* belongs to the provider, and what the
 * queue should do about it belongs to the processor.
 */
function describeTerminalProviderFailure(error: unknown): string | null {
  if (!(error instanceof ProviderError)) return null;
  if (error.kind === 'unrecoverable') return error.message;
  if (error.kind === 'auth-failed') {
    return `${error.message} — reconnect the integration to re-run.`;
  }
  return null;
}

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

  protected async handle(data: TransactionImportJob, ctx: ProcessorContext): Promise<unknown> {
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
        throw userFacing(new UnrecoverableError(error.message));
      }
      // The feed write refused the batch before reading anything, and the
      // same events are refused the same way on every attempt (R38). Its
      // message names every problem code.
      if (error instanceof FeedBatchRejected) {
        throw userFacing(new UnrecoverableError(error.message));
      }
      const terminal = describeTerminalProviderFailure(error);
      if (terminal) throw userFacing(new UnrecoverableError(terminal));
      // The account was deleted, or was never this user's, and is the same
      // on each of the four attempts this descriptor allows (SC-1545).
      throw asJobFailure(error, ctx.job.id);
    }

    await afterLedgerRows(data, result);

    return result;
  }
}
