import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

export const EXCHANGE_BALANCES_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.exchangeBalances,
  lockName: JOB_NAMES.exchangeBalances,
};
