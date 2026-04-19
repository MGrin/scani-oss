import { executePricingCronJob } from '@scani/cron/jobs/pricing';
import type { Job } from 'bullmq';

export async function pricingProcessor(_job: Job): Promise<void> {
  await executePricingCronJob();
}
