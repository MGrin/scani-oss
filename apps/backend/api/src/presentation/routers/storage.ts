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

import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { UPLOAD_LIMITS } from '../../config/limits';
import { protectedProcedure, router } from '../trpc';

const MAX_SIZE_BYTES = UPLOAD_LIMITS.PRESIGN_UPLOAD_BYTES;

// Per-purpose Content-Type allowlist. The presigned URL binds the
// Content-Type into the SigV4 signature so R2 rejects a mismatched
// upload, but accepting arbitrary types here means a caller who pins
// `application/x-msdownload` and constructs a matching PUT writes an
// executable into the bucket. The downstream parsers only handle the
// types below; anything else is junk that would either fail to parse
// or expand the bucket's effective attack surface (e.g. serving the
// stored object back through a permissive CDN). Keep this list tight
// and explicit — broaden only with a security review.
const ALLOWED_CONTENT_TYPES: Record<'screenshot' | 'file-import', readonly string[]> = {
  screenshot: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'],
  'file-import': [
    'text/csv',
    'text/plain',
    'application/csv',
    'application/vnd.ms-excel',
    'application/x-ofx',
    'application/x-qfx',
    'application/x-qif',
    'application/octet-stream',
  ],
};

// Per-purpose filename extension allowlist. Belt-and-braces with the
// content-type check: an attacker who controls both can still craft a
// matched pair, but constraining the extension prevents `evil.exe`
// from ever landing on R2 even if the bucket's object metadata is
// later mishandled.
const ALLOWED_EXTENSIONS: Record<'screenshot' | 'file-import', readonly string[]> = {
  screenshot: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif'],
  'file-import': ['csv', 'txt', 'ofx', 'qfx', 'qif', 'xls'],
};

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
      const normalisedContentType = input.contentType.toLowerCase().split(';')[0]?.trim() ?? '';
      if (!ALLOWED_CONTENT_TYPES[input.purpose].includes(normalisedContentType)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Content-Type "${input.contentType}" is not allowed for purpose "${input.purpose}"`,
        });
      }
      const ext = (input.filename.split('.').pop() ?? 'bin').toLowerCase();
      if (!ALLOWED_EXTENSIONS[input.purpose].includes(ext)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `File extension ".${ext}" is not allowed for purpose "${input.purpose}"`,
        });
      }
      const { uploadUrl, key, expiresAt, requiredHeaders } = await Container.get(
        StorageFacade
      ).presignUpload({
        keyPrefix: `${input.purpose}/${ctx.userId}`,
        extension: ext,
        contentType: normalisedContentType,
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
