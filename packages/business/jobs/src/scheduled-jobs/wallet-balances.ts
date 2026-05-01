import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

export const WALLET_BALANCES_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.walletBalances,
  cron: '0 * * * *',
  lockName: JOB_NAMES.walletBalances,
};
