import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

export const WALLET_BALANCES_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.walletBalances,
  lockName: JOB_NAMES.walletBalances,
};
