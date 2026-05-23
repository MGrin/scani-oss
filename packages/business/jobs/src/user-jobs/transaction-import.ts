import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';

export interface TransactionImportJob extends UserJobBase {
  accountId: string;
  // Stable tag that the consumer maps to a TransactionIngester
  // (etherscan / binance-api / kraken-api / statement-csv …).
  source: string;
  // Optional ISO-8601 timestamp; incremental ingests use this.
  since?: string;
  // Surfaces in user_jobs.payloadSummary so /jobs shows a useful label.
  institutionId?: string;
}

export const transactionImportSchema: z.ZodType<TransactionImportJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  accountId: z.string().uuid(),
  source: z.string().min(1),
  since: z.string().optional(),
  institutionId: z.string().optional(),
});

const JOB_ID_SEP = '_';

export const TRANSACTION_IMPORT: UserJobDescriptor<TransactionImportJob> = {
  name: JOB_NAMES.transactionImport,
  schema: transactionImportSchema,
  defaultOpts: {
    // Upstream HTTP APIs are flaky; histories can span years and a
    // mid-fetch 429 is common. The processor itself is idempotent per
    // (account, source, external_id) so retry is safe.
    attempts: 4,
    backoff: { type: 'exponential', delay: 15_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  // Dedup key: (user, account, source, requestId). A re-ingest with a
  // fresh requestId gets a new id; accidental double-click with the
  // same requestId collapses via BullMQ's native dedup.
  computeJobId: (d) =>
    [JOB_NAMES.transactionImport, d.userId, d.accountId, d.source, d.requestId].join(JOB_ID_SEP),
  summarizePayload: (d) => ({
    accountId: d.accountId,
    source: d.source,
    institutionId: d.institutionId,
    since: d.since,
  }),
};
