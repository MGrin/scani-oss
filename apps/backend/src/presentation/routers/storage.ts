/**
 * Storage router — presigns R2 upload URLs for large job payloads.
 *
 * Frontend calls `storage.getUploadUrl({ contentType, purpose })`, PUTs the
 * raw file directly to the returned URL, and then passes the returned key
 * into the async mutation (e.g. `screenshots.parseScreenshotsAsync`).
 *
 * Scoped under `temp/<purpose>/` so the bucket's 24h lifecycle rule sweeps
 * orphans from failed jobs.
 */

import { presignUpload } from '@scani/cloud-client/storage-facade';
import { z } from 'zod';
import { UPLOAD_LIMITS } from '../../config/limits';
import { protectedProcedure, router } from '../trpc';

const MAX_SIZE_BYTES = UPLOAD_LIMITS.PRESIGN_UPLOAD_BYTES;

export const storageRouter = router({
  getUploadUrl: protectedProcedure
    .input(
      z.object({
        purpose: z.enum(['screenshot', 'file-import']),
        contentType: z.string().min(1).max(200),
        filename: z.string().min(1).max(200),
        sizeBytes: z.number().int().positive().max(MAX_SIZE_BYTES),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const ext = (input.filename.split('.').pop() ?? 'bin').toLowerCase();
      const { uploadUrl, key, expiresAt, requiredHeaders } = await presignUpload({
        keyPrefix: `${input.purpose}/${ctx.userId}`,
        extension: ext,
        contentType: input.contentType,
        contentLength: input.sizeBytes,
        ttlSeconds: 15 * 60,
      });
      return {
        uploadUrl,
        key,
        expiresAt,
        method: 'PUT' as const,
        // The client must echo these headers verbatim — they're bound
        // into the SigV4 signature, so R2 rejects any mismatch.
        headers: requiredHeaders,
      };
    }),
});
