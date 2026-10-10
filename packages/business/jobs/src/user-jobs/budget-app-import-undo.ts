import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';

export interface BudgetAppImportUndoJob extends UserJobBase {
  importId: string;
}

const budgetAppImportUndoSchema: z.ZodType<BudgetAppImportUndoJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  importId: z.string().uuid(),
});

/** Undoes one upload: removes the rows it inserted and the accounts it opened (SC-1649). */
export const BUDGET_APP_IMPORT_UNDO: UserJobDescriptor<BudgetAppImportUndoJob> = {
  name: JOB_NAMES.budgetAppImportUndo,
  schema: budgetAppImportUndoSchema,
  defaultOpts: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  computeJobId: (d) => [JOB_NAMES.budgetAppImportUndo, d.userId, d.importId].join('_'),
  summarizePayload: () => ({}),
};
