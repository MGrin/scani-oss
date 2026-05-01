import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';

export interface FileImportJob extends UserJobBase {
  r2Key: string;
  fileType: 'csv' | 'ofx' | 'qif';
  accountId: string;
  enrich?: boolean;
  // ISO-4217 fallback used when the file has no Currency column AND
  // no detectable per-row currency. Set by the user via the
  // currency-picker UI on the failed first attempt's job-detail page.
  defaultCurrency?: string;
}

export const fileImportSchema: z.ZodType<FileImportJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  r2Key: z.string().min(1),
  fileType: z.enum(['csv', 'ofx', 'qif']),
  accountId: z.string().min(1),
  enrich: z.boolean().optional(),
  defaultCurrency: z.string().min(1).max(8).optional(),
});

const JOB_ID_SEP = '_';

export const FILE_IMPORT: UserJobDescriptor<FileImportJob> = {
  name: JOB_NAMES.fileImport,
  schema: fileImportSchema,
  defaultOpts: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  computeJobId: (d) => [JOB_NAMES.fileImport, d.userId, d.accountId, d.requestId].join(JOB_ID_SEP),
  summarizePayload: (d) => ({
    fileType: d.fileType,
    accountId: d.accountId,
    enrich: d.enrich ?? false,
  }),
};
