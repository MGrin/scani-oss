import { createHash } from 'node:crypto';
import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';

export interface ScreenshotParseJob extends UserJobBase {
  r2Keys: string[];
  provider: string;
  accountType: string;
  expectedCurrency: string;
  context?: string;
  minConfidence?: number;
  accountId?: string;
}

export const screenshotParseSchema: z.ZodType<ScreenshotParseJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  r2Keys: z.array(z.string().min(1)).min(1).max(10),
  provider: z.string().min(1),
  accountType: z.string().min(1),
  expectedCurrency: z.string().min(1),
  context: z.string().optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  accountId: z.string().optional(),
});

const JOB_ID_SEP = '_';

export const SCREENSHOT_PARSE: UserJobDescriptor<ScreenshotParseJob> = {
  name: JOB_NAMES.screenshotParse,
  schema: screenshotParseSchema,
  defaultOpts: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  computeJobId: (d) => {
    // Hash the r2Keys list into the jobId so two parallel uploads with
    // overlapping requestIds (rare but possible if a UUID collides) still
    // dedup per file-set. 16 hex chars = 64 bits, ample for collision
    // resistance within a single user's job stream.
    const keyDigest = createHash('sha256').update(d.r2Keys.join('|')).digest('hex').slice(0, 16);
    return [JOB_NAMES.screenshotParse, d.userId, keyDigest, d.requestId].join(JOB_ID_SEP);
  },
  summarizePayload: (d) => ({
    fileCount: d.r2Keys.length,
    provider: d.provider,
    accountType: d.accountType,
    expectedCurrency: d.expectedCurrency,
    accountId: d.accountId,
  }),
};
