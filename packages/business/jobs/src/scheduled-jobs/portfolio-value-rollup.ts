import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

export const PORTFOLIO_VALUE_ROLLUP_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.portfolioValueRollup,
  cron: '0 4 * * *',
  lockName: JOB_NAMES.portfolioValueRollup,
};
