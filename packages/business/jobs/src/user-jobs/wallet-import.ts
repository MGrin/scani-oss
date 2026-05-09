import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';
import { RETRY_EXTERNAL } from '../retry-policies';

export interface WalletImportJob extends UserJobBase {
  chain: string;
  address: string;
  label?: string;
  // Pre-detected institution IDs from the frontend's `wallet.detectChains`
  // step. When present, the worker skips the redundant detection.
  detectedInstitutionIds?: string[];
}

export const walletImportSchema: z.ZodType<WalletImportJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  chain: z.string().min(1),
  address: z.string().min(1),
  label: z.string().optional(),
  detectedInstitutionIds: z.array(z.string()).optional(),
});

const JOB_ID_SEP = '_';

function redactAddress(addr: string): string {
  if (typeof addr !== 'string' || addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export const WALLET_IMPORT: UserJobDescriptor<WalletImportJob> = {
  name: JOB_NAMES.walletImport,
  schema: walletImportSchema,
  defaultOpts: {
    ...RETRY_EXTERNAL,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  computeJobId: (d) =>
    [JOB_NAMES.walletImport, d.userId, d.chain, d.address.toLowerCase(), d.requestId].join(
      JOB_ID_SEP
    ),
  summarizePayload: (d) => ({
    chain: d.chain,
    address: redactAddress(d.address),
    label: d.label,
  }),
};
