import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Daily refresh of integration transaction LEDGERS (the hourly
// exchange-balances job only refreshes positions). Fans out a
// transaction-import job per syncable account. Daily — the ledger is
// historical and IBKR Flex queries are slow/serialized, so sub-daily
// would hammer the upstream for no benefit.
export const EXCHANGE_TRANSACTIONS_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.exchangeTransactions,
  cron: '0 1 * * *',
  lockName: JOB_NAMES.exchangeTransactions,
};
