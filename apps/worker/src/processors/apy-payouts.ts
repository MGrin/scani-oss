import { executeApyPayoutsCronJob } from '@scani/cron/jobs/apy-payouts';
import type { Job } from 'bullmq';

export async function apyPayoutsProcessor(_job: Job): Promise<void> {
  await executeApyPayoutsCronJob();
}
