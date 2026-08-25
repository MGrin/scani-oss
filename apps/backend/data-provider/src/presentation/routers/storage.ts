import { createComponentLogger } from '@scani/logging';
import { StorageService } from '@scani/storage';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { okOutput } from '../schemas';
import { internalProcedure, router } from '../trpc';

// Storage router — the only container with R2/MinIO credentials. For Tier
// 2/3 deployments this wraps Scani's managed bucket; for Tier 1 OSS a user
// can stand up MinIO next to this service. Backend and worker never see
// the access keys — they ask for presigned URLs (so browser-direct uploads
// still work) or stream the temp blob back through tRPC for the rare
// read-on-server path.

const log = createComponentLogger('data-provider:storage');

// Published response schema (SC-108) — `PresignedUpload` from
// @scani/storage, 1:1.
const presignedUploadOut = z.object({
  uploadUrl: z.string(),
  key: z.string(),
  expiresAt: z.string(),
  requiredHeaders: z.record(z.string()),
});
const storage = (): StorageService => Container.get(StorageService);

// 256KB of payload, expressed in base64 characters (4 chars per 3 bytes).
// Enforced on the wire so an oversized body is refused by zod before it is
// decoded into a Buffer, rather than after.
const WRITE_OBJECT_MAX_BASE64_CHARS = Math.ceil((256 * 1024 * 4) / 3);

export const storageRouter = router({
  presignUpload: internalProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/trpc/storage.presignUpload',
        tags: ['storage'],
        summary: 'Get a presigned URL for direct-to-R2 PUT upload',
        protect: true,
      },
    })
    .input(
      z.object({
        keyPrefix: z.string(),
        extension: z.string(),
        contentType: z.string(),
        contentLength: z.number(),
        ttlSeconds: z.number().optional(),
      })
    )
    .output(presignedUploadOut)
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

  presignDownload: internalProcedure
    .meta({
      openapi: {
        method: 'GET',
        path: '/trpc/storage.presignDownload',
        tags: ['storage'],
        summary: 'Get a presigned URL to GET an R2 object',
        protect: true,
      },
    })
    .input(z.object({ key: z.string(), ttlSeconds: z.number().optional() }))
    .output(z.object({ url: z.string() }))
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

  objectExists: internalProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/trpc/storage.objectExists',
        tags: ['storage'],
        summary: 'Whether an object is present, without transferring it',
        protect: true,
      },
    })
    .input(z.object({ key: z.string() }))
    .output(z.object({ exists: z.boolean() }))
    .mutation(async ({ input }) => {
      try {
        return { exists: await storage().exists(input.key) };
      } catch (err) {
        // Deliberately not degraded to `{ exists: false }`. The caller
        // refuses an upload on a false, and "the bucket did not answer" is
        // not evidence that the user's file is missing.
        log.warn(
          { key: input.key, error: err instanceof Error ? err.message : String(err) },
          'objectExists failed'
        );
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  // Streams the blob back as base64 — tRPC-over-HTTP doesn't do binary
  // transport, and at temp-blob sizes the ~33% bloat isn't worth a
  // parallel binary endpoint.
  readTempBlob: internalProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/trpc/storage.readTempBlob',
        tags: ['storage'],
        summary: 'Read a temp blob and return it as base64 (no binary transport)',
        protect: true,
      },
    })
    .input(z.object({ key: z.string() }))
    .output(z.object({ base64: z.string(), byteLength: z.number() }))
    .mutation(async ({ input }) => {
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

  // Read an object AND the content type it was stored with (SC-208).
  //
  // `readTempBlob` cannot answer this: it returns bytes alone, and an
  // institution icon has to be re-served over HTTP, which needs its type.
  // Recording the type in the key's extension instead would mean the reader
  // has to know the extension before it can ask — which is the thing it is
  // asking for.
  //
  // A miss is `{ found: false }`, not a throw. The caller's next move is to
  // resolve the icon from the institution's website, and an absent object is
  // the ordinary first-ever request rather than an error.
  readObject: internalProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/trpc/storage.readObject',
        tags: ['storage'],
        summary: 'Read an object as base64 together with its stored content type',
        protect: true,
      },
    })
    .input(z.object({ key: z.string() }))
    .output(
      z.object({
        found: z.boolean(),
        base64: z.string(),
        contentType: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const object = await storage().readObject(input.key);
        if (!object) return { found: false, base64: '', contentType: '' };
        return {
          found: true,
          base64: Buffer.from(object.bytes).toString('base64'),
          contentType: object.contentType,
        };
      } catch (err) {
        log.warn(
          { key: input.key, error: err instanceof Error ? err.message : String(err) },
          'readObject failed'
        );
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  // Store bytes the CALLER produced, under a key the caller chose (SC-208).
  //
  // Every other write path here hands out a presigned URL so the bytes go
  // browser-to-R2 and never touch a Scani process. This one exists because
  // the institution icon is fetched by the api from a third-party site, so
  // the bytes are already in a Scani process and the key is server-chosen —
  // `presignUpload` would force them into `temp/<prefix>/<uuid>`, a jail for
  // user uploads that a permanent object does not belong in.
  //
  // Capped at 256KB. That is twice the icon cap in `@scani/http-fetch`, and
  // the point of the cap is that this is not a general file-upload endpoint:
  // if a caller ever needs one, it should have to change this line and say
  // why.
  writeObject: internalProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/trpc/storage.writeObject',
        tags: ['storage'],
        summary: 'Write caller-supplied bytes to a caller-chosen key',
        protect: true,
      },
    })
    .input(
      z.object({
        key: z.string(),
        base64: z.string().max(WRITE_OBJECT_MAX_BASE64_CHARS),
        contentType: z.string(),
      })
    )
    .output(okOutput)
    .mutation(async ({ input }) => {
      try {
        const bytes = Buffer.from(input.base64, 'base64');
        await storage().write(input.key, bytes, input.contentType);
        return { ok: true };
      } catch (err) {
        log.warn(
          { key: input.key, error: err instanceof Error ? err.message : String(err) },
          'writeObject failed'
        );
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  // Server-side duplicate. The alternative — readTempBlob then a write
  // endpoint — would drag the whole file through the caller's process and
  // back as base64 for no gain; the bytes never need to leave this
  // container.
  copyObject: internalProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/trpc/storage.copyObject',
        tags: ['storage'],
        summary: 'Copy an object to a second key, leaving the source in place',
        protect: true,
      },
    })
    .input(
      z.object({
        fromKey: z.string(),
        toKey: z.string(),
        contentType: z.string().optional(),
      })
    )
    .output(okOutput)
    .mutation(async ({ input }) => {
      try {
        await storage().copy(input.fromKey, input.toKey, input.contentType);
        return { ok: true };
      } catch (err) {
        log.warn(
          {
            fromKey: input.fromKey,
            toKey: input.toKey,
            error: err instanceof Error ? err.message : String(err),
          },
          'copyObject failed'
        );
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  deleteTempBlob: internalProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/trpc/storage.deleteTempBlob',
        tags: ['storage'],
        summary: 'Delete a temp blob from object storage',
        protect: true,
      },
    })
    .input(z.object({ key: z.string() }))
    .output(okOutput)
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
