import { executeExchangeBalancesCronJob } from '@scani/cron/jobs/exchange-balances';
import type { Job } from 'bullmq';

export async function exchangeBalancesProcessor(_job: Job): Promise<void> {
  await executeExchangeBalancesCronJob();
}
