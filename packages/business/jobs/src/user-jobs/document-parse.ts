import { createHash } from 'node:crypto';
import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';

export interface DocumentParseJob extends UserJobBase {
  r2Key: string;
  mimeType: string;
  originalFilename: string;
  sourceKind: 'upload' | 'email';
  /**
   * A `documents.id` to re-extract into, instead of ingesting a new file.
   * Set, the ingestion skips its content-hash dedup and attaches the fresh
   * extractions to that row — the escape hatch for "the extractor improved,
   * read my invoice again". Optional so jobs enqueued before this field
   * existed still pass `documentParseSchema` on the worker.
   */
  reparseOf?: string;
}

export const documentParseSchema: z.ZodType<DocumentParseJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  r2Key: z.string().min(1),
  mimeType: z.string().min(1),
  originalFilename: z.string().min(1),
  sourceKind: z.enum(['upload', 'email']),
  reparseOf: z.string().uuid().optional(),
});

const JOB_ID_SEP = '_';

export const DOCUMENT_PARSE: UserJobDescriptor<DocumentParseJob> = {
  name: JOB_NAMES.documentParse,
  schema: documentParseSchema,
  defaultOpts: {
    // Mirrors screenshot-parse: one AI call against a provider that can
    // be transiently flaky, but re-running a whole extraction is cheap
    // enough (single file, not a batch) not to need a long backoff.
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  computeJobId: (d) => {
    // Hash the r2Key rather than trusting requestId alone — same
    // collision-resistance rationale as screenshot-parse's keyDigest.
    // A re-parse reuses the document's own r2Key, so `requestId` is the
    // ONLY part that differs from the original parse: callers must mint a
    // fresh one or BullMQ dedups the re-parse away as a double-submit.
    const keyDigest = createHash('sha256').update(d.r2Key).digest('hex').slice(0, 16);
    return [JOB_NAMES.documentParse, d.userId, keyDigest, d.requestId].join(JOB_ID_SEP);
  },
  summarizePayload: (d) => ({
    mimeType: d.mimeType,
    originalFilename: d.originalFilename,
    sourceKind: d.sourceKind,
    ...(d.reparseOf ? { reparseOf: d.reparseOf } : {}),
  }),
};
