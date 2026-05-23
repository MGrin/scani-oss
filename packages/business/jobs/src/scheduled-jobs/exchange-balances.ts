import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

export const EXCHANGE_BALANCES_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.exchangeBalances,
  cron: '0 * * * *',
  lockName: JOB_NAMES.exchangeBalances,
};
