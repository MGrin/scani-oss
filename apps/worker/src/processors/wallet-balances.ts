import { executeWalletBalancesCronJob } from '@scani/cron/jobs/wallet-balances';
import type { Job } from 'bullmq';

export async function walletBalancesProcessor(_job: Job): Promise<void> {
  await executeWalletBalancesCronJob();
}
