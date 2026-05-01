import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';

const newHoldingSchema = z.object({
  tokenId: z.string().uuid(),
  balance: z.string().min(1),
});

const updateHoldingSchema = z.object({
  holdingId: z.string().uuid(),
  balance: z.string().min(1),
});

const institutionInputSchema = z.object({
  name: z.string().min(1),
  typeId: z.string().uuid(),
  website: z.string().optional(),
});

const accountInputSchema = z.object({
  name: z.string().min(1),
  typeId: z.string().uuid(),
  institutionId: z.string().uuid().optional(),
});

export interface ManualHoldingsCreateJob extends UserJobBase {
  baseCurrencyId: string;
  institution?: { name: string; typeId: string; website?: string };
  accountId?: string;
  account?: { name: string; typeId: string; institutionId?: string };
  newHoldings: Array<{ tokenId: string; balance: string }>;
  updateHoldings: Array<{ holdingId: string; balance: string }>;
  parentJobIdToStampOnSuccess?: string;
}

export const manualHoldingsCreateSchema: z.ZodType<ManualHoldingsCreateJob> = z
  .object({
    userId: z.string().min(1),
    requestId: z.string().min(1),
    baseCurrencyId: z.string().uuid(),
    institution: institutionInputSchema.optional(),
    accountId: z.string().uuid().optional(),
    account: accountInputSchema.optional(),
    newHoldings: z.array(newHoldingSchema),
    updateHoldings: z.array(updateHoldingSchema),
    parentJobIdToStampOnSuccess: z.string().min(1).optional(),
  })
  .refine((d) => d.newHoldings.length + d.updateHoldings.length > 0, {
    message: 'At least one holding (new or updated) is required',
    path: ['newHoldings'],
  })
  .refine((d) => Boolean(d.accountId || d.account), {
    message: 'Either accountId or account details must be provided',
    path: ['accountId'],
  });

export const MANUAL_HOLDINGS_CREATE: UserJobDescriptor<ManualHoldingsCreateJob> = {
  name: JOB_NAMES.manualHoldingsCreate,
  schema: manualHoldingsCreateSchema,
  defaultOpts: {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  computeJobId: (d) => [JOB_NAMES.manualHoldingsCreate, d.userId, d.requestId].join('_'),
  summarizePayload: (d) => ({
    newCount: d.newHoldings.length,
    updateCount: d.updateHoldings.length,
    accountId: d.accountId ?? null,
    hasNewInstitution: Boolean(d.institution),
    hasNewAccount: Boolean(d.account),
    parentJobId: d.parentJobIdToStampOnSuccess ?? null,
  }),
};
