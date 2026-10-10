import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

export const PORTFOLIO_VALUE_ROLLUP_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.portfolioValueRollup,
  lockName: JOB_NAMES.portfolioValueRollup,
};
