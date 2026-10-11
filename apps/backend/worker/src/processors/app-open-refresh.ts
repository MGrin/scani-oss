import { AppOpenRefreshService } from '@scani/domain/services';
import { APP_OPEN_REFRESH, type AppOpenRefreshJob, REFRESH_ACCOUNT_BALANCE } from '@scani/jobs';
import { BullMqEnqueueService, type ProcessorContext, UserJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

// The app came back to the front (SC-1602). The api used to work out the
// accounts inside the request, and that held its event loop for 19.4 s on
// production on every return to the tab (SC-1671); it now enqueues this.
@Service()
export class AppOpenRefreshProcessor extends UserJobProcessor<
  AppOpenRefreshJob,
  { accountsQueued: number }
> {
  readonly descriptor = APP_OPEN_REFRESH;

  protected async handle(
    data: AppOpenRefreshJob,
    _ctx: ProcessorContext
  ): Promise<{ accountsQueued: number }> {
    const accountIds = await Container.get(AppOpenRefreshService).accountsToRefresh(data.userId);
    const enqueue = Container.get(BullMqEnqueueService);
    for (const accountId of accountIds) {
      await enqueue.add(REFRESH_ACCOUNT_BALANCE, {
        userId: data.userId,
        requestId: data.requestId,
        accountId,
      });
    }
    return { accountsQueued: accountIds.length };
  }
}
