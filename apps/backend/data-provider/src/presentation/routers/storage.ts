import { createComponentLogger } from '@scani/logging';
import { StorageService } from '@scani/storage';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { bearerProcedure, router } from '../trpc';

// Storage router — the only container with R2/MinIO credentials. For Tier
// 2/3 deployments this wraps Scani's managed bucket; for Tier 1 OSS a user
// can stand up MinIO next to this service. Backend and worker never see
// the access keys — they ask for presigned URLs (so browser-direct uploads
// still work) or stream the temp blob back through tRPC for the rare
// read-on-server path.

const log = createComponentLogger('data-provider:storage');
const storage = (): StorageService => Container.get(StorageService);

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
        return storage().presignUpload(input);
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
        return { url: storage().presignDownload(input.key, input.ttlSeconds) };
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  // Streams the blob back as base64 — tRPC-over-HTTP doesn't do binary
  // transport, and at temp-blob sizes the ~33% bloat isn't worth a
  // parallel binary endpoint.
  readTempBlob: bearerProcedure.input(z.object({ key: z.string() })).mutation(async ({ input }) => {
    try {
      const buf = await storage().read(input.key);
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
        await storage().delete(input.key);
        return { ok: true };
      } catch (err) {
        // StorageService swallows 404s already; anything else is real.
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
});
