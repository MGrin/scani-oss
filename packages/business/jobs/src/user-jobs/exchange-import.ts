import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { jobIdOf } from '../job-id';
import { JOB_NAMES } from '../job-names';
import { RETRY_EXTERNAL } from '../retry-policies';

export interface ExchangeImportJob extends UserJobBase {
  // Credentials are AES-GCM encrypted at rest by IntegrationCredentialsService
  // before enqueue, so the payload carries only the institution reference.
  institutionId: string;
  provider: string;
}

const exchangeImportSchema: z.ZodType<ExchangeImportJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  institutionId: z.string().min(1),
  provider: z.string().min(1),
});

export const EXCHANGE_IMPORT: UserJobDescriptor<ExchangeImportJob> = {
  name: JOB_NAMES.exchangeImport,
  schema: exchangeImportSchema,
  defaultOpts: {
    ...RETRY_EXTERNAL,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  computeJobId: (d) => jobIdOf(JOB_NAMES.exchangeImport, d.userId, d.institutionId, d.requestId),
  summarizePayload: (d) => ({ institutionId: d.institutionId, provider: d.provider }),
};
