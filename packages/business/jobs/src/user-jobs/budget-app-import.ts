import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';

const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new'), typeCode: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('existing'), accountId: z.string().uuid() }),
  z.object({ kind: z.literal('skip') }),
]);

export interface BudgetAppImportJob extends UserJobBase {
  /** The uploaded register, under `temp/file-import/<userId>/`. */
  r2Key: string;
  app: 'ynab' | 'actual' | 'mint';
  /** ISO code, as the person confirmed or chose it; Actual's and Mint's exports name none. */
  currency: string;
  /** Asked for only when the file's dates fit either order. */
  dateOrder?: 'day-first' | 'month-first';
  accounts: Array<{ name: string; target: z.infer<typeof target> }>;
}

const budgetAppImportSchema: z.ZodType<BudgetAppImportJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  r2Key: z.string().min(1),
  app: z.enum(['ynab', 'actual', 'mint']),
  currency: z.string().min(2).max(12),
  dateOrder: z.enum(['day-first', 'month-first']).optional(),
  accounts: z
    .array(z.object({ name: z.string().min(1).max(200), target }))
    .min(1)
    .max(200),
});

/**
 * Imports a YNAB, Actual Budget or Mint register (SC-1649): one transaction, so a failed attempt
 * leaves nothing and a retry starts clean; a refusal ends the job at once.
 */
export const BUDGET_APP_IMPORT: UserJobDescriptor<BudgetAppImportJob> = {
  name: JOB_NAMES.budgetAppImport,
  schema: budgetAppImportSchema,
  defaultOpts: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  computeJobId: (d) => [JOB_NAMES.budgetAppImport, d.userId, d.requestId].join('_'),
  summarizePayload: (d) => ({ app: d.app, accounts: d.accounts.length }),
};
