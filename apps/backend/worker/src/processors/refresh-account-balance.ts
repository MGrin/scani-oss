import { RefreshAccountBalanceUseCase } from '@scani/domain/use-cases';
import { REFRESH_ACCOUNT_BALANCE, type RefreshAccountBalanceJob } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { type ProcessorContext, RedisResourceLock, UserJobProcessor } from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:refresh-account-balance');

// Long enough that the slowest provider (IBKR Flex Query, multi-minute
// generation) has time to settle inside the window without the lock
// expiring; short enough that a crashed worker's lock unblocks within a
// reasonable retry budget.
const REFRESH_LOCK_TTL_MS = 5 * 60 * 1000;

// Per-account balance refresh, queued by the user clicking "Refresh
// balance" on a holding row. The shape mirrors HoldingPriceUpdate's:
// per-resource Redis lock to coalesce duplicate clicks, run the use
// case, emit a `holding.update` event so the WS pipe reloads the UI.
@Service()
export class RefreshAccountBalanceProcessor extends UserJobProcessor<
  RefreshAccountBalanceJob,
  unknown
> {
  readonly descriptor = REFRESH_ACCOUNT_BALANCE;
  private readonly resourceLock = Container.get(RedisResourceLock);

  protected async handle(data: RefreshAccountBalanceJob, _ctx: ProcessorContext): Promise<unknown> {
    const lockKey = `lock:refresh-balance:${data.accountId}`;
    const lock = await this.resourceLock.acquire(lockKey, REFRESH_LOCK_TTL_MS);
    if (!lock.ok) {
      logger.info(
        { accountId: data.accountId, userId: data.userId },
        'Refresh-balance already in progress for this account — skipping duplicate'
      );
      return { skipped: true, reason: 'lock-contention' };
    }
    try {
      const result = await Container.get(RefreshAccountBalanceUseCase).execute({
        userId: data.userId,
        holdingId: data.holdingId,
        accountId: data.accountId,
      });

      // Tell the WS pipe to reload the user's holdings list — the
      // entityId is the holdingId the user clicked from, but the
      // payload's reason is generic so the frontend can decide
      // whether to invalidate the entire portfolio or a single row.
      emitEntityChange({
        entityType: 'holding',
        operationType: 'update',
        entityId: data.holdingId,
        userId: data.userId,
        data: { reason: 'refresh-account-balance', accountId: data.accountId },
      });

      return result;
    } finally {
      await lock.release();
    }
  }
}
