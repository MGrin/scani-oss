import { createComponentLogger } from '@scani/logging';
import { deleteTempBlob, presignDownload, presignUpload, readTempBlob } from '@scani/storage';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { bearerProcedure, router } from '../trpc';

/**
 * Storage router — the only container with R2/MinIO credentials.
 *
 * For Tier 2/3 deployments this wraps Scani's managed R2 bucket; for
 * Tier 1 (OSS self-host) a user can stand up MinIO next to this service.
 * Either way, backend and worker never see the access keys — they ask
 * for presigned URLs (so browser-direct uploads still work) or stream
 * the temp blob back through tRPC for the rare read-on-server path.
 */

const log = createComponentLogger('data-provider:storage');

export const storageRouter = router({
  presignUpload: bearerProcedure
    .input(
      z.object({
        keyPrefix: z.string(),
        extension: z.string(),
        contentType: z.string(),
        contentLength: z.number(),
        ttlSeconds: z.number().optional(),
      })
    )
    .mutation(({ input }) => {
      try {
        return presignUpload(input);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  presignDownload: bearerProcedure
    .input(z.object({ key: z.string(), ttlSeconds: z.number().optional() }))
    .query(({ input }) => {
      try {
        return { url: presignDownload(input.key, input.ttlSeconds) };
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  /**
   * Stream a temp blob back to the caller as base64. Large payloads
   * (screenshots, CSVs) go this way because tRPC-over-HTTP doesn't do
   * binary transport — base64 bloats by ~33% but the blobs are small
   * enough that it's not worth a parallel binary endpoint.
   *
   * `readTempBlob` returns a Buffer; we serialize to base64 and let the
   * adapter on the other side rehydrate.
   */
  readTempBlob: bearerProcedure.input(z.object({ key: z.string() })).mutation(async ({ input }) => {
    try {
      const buf = await readTempBlob(input.key);
      return { base64: buf.toString('base64'), byteLength: buf.byteLength };
    } catch (err) {
      log.warn(
        { key: input.key, error: err instanceof Error ? err.message : String(err) },
        'readTempBlob failed'
      );
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }),

  deleteTempBlob: bearerProcedure
    .input(z.object({ key: z.string() }))
    .mutation(async ({ input }) => {
      try {
        await deleteTempBlob(input.key);
        return { ok: true };
      } catch (err) {
        // The inner helper swallows 404s already; anything else is real.
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
});
