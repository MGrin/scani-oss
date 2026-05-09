/**
 * File import router
 * Handles bank statement file parsing and preview
 */

import { CsvColumnDetectionService } from '@scani/domain/services';
import { BANK_TEMPLATES, parseStatement } from '@scani/file-import';
import { FILE_IMPORT } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { BullMqEnqueueService } from '@scani/queue';
import { createOutflowLimiter, getSharedRedis } from '@scani/rate-limiter';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { UPLOAD_LIMITS } from '../../config/limits';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const fileImportLogger = createComponentLogger('router:file-import');

// Safety caps — centralised in `@/config/limits.ts` so audit is one diff.
// Base64 inputs up to ~4 MB decode to ~3 MB of raw bytes, which expands
// into much more heap during parsing. Post-parse caps bound the result
// regardless of how compressible the input was.
const MAX_PARSED_TRANSACTIONS = UPLOAD_LIMITS.PARSED_TRANSACTIONS;
const MAX_DECODED_BYTES = UPLOAD_LIMITS.INLINE_DECODED_BYTES;

// Per-user budget for the parse endpoint. The decode + parse pipeline
// is CPU-heavy (CSV/OFX/QIF parser, optional AI column detection on
// the worker side), so the global tRPC strict-limiter (60/min) is
// far too generous. 4/min is enough headroom for legitimate "preview,
// fix mapping, re-preview" flows without giving a hostile client a
// CPU-DoS vector.
const fileImportParseLimiter = createOutflowLimiter({
  maxRequests: 4,
  windowMs: 60_000,
  redis: getSharedRedis(),
  namespace: 'inflow:file-import-parse',
});

export const fileImportRouter = router({
  /** Get available bank templates for CSV parsing */
  getTemplates: protectedProcedure.query(() => {
    return Object.entries(BANK_TEMPLATES).map(([key, template]) => ({
      key,
      dateColumn: template.date,
      descriptionColumn: template.description,
      amountColumn: template.amount,
      currencyColumn: template.currency || null,
      balanceColumn: template.balance || null,
    }));
  }),

  /** Parse a bank statement file and return preview of transactions */
  parse: protectedProcedure
    .input(
      z.object({
        /** Base64-encoded file content */
        content: z.string().min(1).max(4_000_000, 'File too large (max ~3MB)'),
        /** Original filename (used for format detection) */
        filename: z.string().min(1),
        /** Bank template name (optional, auto-detected for CSV) */
        bankTemplate: z.string().optional(),
        /** Custom CSV column mapping (optional) */
        customMapping: z
          .object({
            date: z.string(),
            description: z.string(),
            amount: z.string(),
            credit: z.string().optional(),
            debit: z.string().optional(),
            currency: z.string().optional(),
            balance: z.string().optional(),
            dateFormat: z.string().optional(),
            skipRows: z.number().optional(),
            delimiter: z.string().optional(),
          })
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Per-user budget. Rejects before any decode / parse / AI hit.
      const { dbUser } = await requireAuth(ctx);
      const budget = await fileImportParseLimiter.tryConsume(dbUser.id);
      if (!budget.ok) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Too many parse attempts. Try again in ${Math.ceil(budget.retryAfterMs / 1000)}s.`,
        });
      }

      fileImportLogger.info(
        { filename: input.filename, bankTemplate: input.bankTemplate },
        'Parsing bank statement file'
      );

      // Decode base64 content
      let decoded: string;
      try {
        decoded = Buffer.from(input.content, 'base64').toString('utf-8');
      } catch {
        decoded = input.content; // Try as plain text
      }

      // Reject files that decode to oversized payloads regardless of the
      // base64 size. Belt-and-braces with the input-level `.max()`.
      const decodedBytes = Buffer.byteLength(decoded, 'utf-8');
      if (decodedBytes > MAX_DECODED_BYTES) {
        throw new TRPCError({
          code: 'PAYLOAD_TOO_LARGE',
          message: `Decoded file is too large (${decodedBytes} bytes, max ${MAX_DECODED_BYTES})`,
        });
      }

      const csvColumnDetectionService = Container.get(CsvColumnDetectionService);
      const result = await parseStatement(decoded, input.filename, {
        bankTemplate: input.bankTemplate,
        customMapping: input.customMapping,
        aiColumnDetector: (headers, sampleRows) =>
          csvColumnDetectionService.detectColumns(headers, sampleRows),
      });

      // Cap the number of parsed transactions to bound memory/response size.
      if (result.transactions.length > MAX_PARSED_TRANSACTIONS) {
        throw new TRPCError({
          code: 'PAYLOAD_TOO_LARGE',
          message: `File contains ${result.transactions.length} transactions, max ${MAX_PARSED_TRANSACTIONS}`,
        });
      }

      fileImportLogger.info(
        {
          filename: input.filename,
          format: result.format,
          bankTemplate: result.bankTemplate,
          transactionCount: result.transactions.length,
          holdingCount: result.holdings.length,
          detectedCurrency: result.detectedCurrency,
          warningCount: result.warnings.length,
        },
        'File parsed successfully'
      );

      return {
        transactions: result.transactions.map((tx) => ({
          date: tx.date.toISOString(),
          description: tx.description,
          amount: tx.amount,
          currency: tx.currency,
          balance: tx.balance ?? null,
        })),
        holdings: result.holdings.map((h) => ({
          symbol: h.symbol,
          name: h.name ?? null,
          balance: h.balance,
          confidence: h.confidence,
          notes: h.notes ?? null,
        })),
        format: result.format,
        bankTemplate: result.bankTemplate ?? null,
        detectedCurrency: result.detectedCurrency ?? null,
        warnings: result.warnings,
        totalCount: result.transactions.length,
      };
    }),

  /**
   * Parse + enrich a bank statement asynchronously.
   *
   * The client uploads the file to R2 via `storage.getUploadUrl` and then
   * calls this mutation with the returned `r2Key`. Enrichment (token
   * lookup + existing-holdings match) can take several seconds on large
   * CSVs, so it now runs on the worker. Returns a jobId for the UI to
   * track via WebSocket / jobs.status.
   */
  parseAndEnrich: protectedProcedure
    .input(
      z.object({
        r2Key: z.string().min(1),
        fileType: z.enum(['csv', 'ofx', 'qif']).default('csv'),
        accountId: z.string().min(1, 'accountId is required'),
        requestId: z.string().uuid(),
        // Forwarded to the file-import worker as a fallback when the
        // file has no Currency column. Set by the picker UI on the
        // failed first-attempt's job-detail page.
        defaultCurrency: z.string().min(1).max(8).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Enforce that the R2 key belongs to the caller. Without this, a
      // leaked key from another user (logs, client telemetry, replay)
      // could be submitted here and the worker would fetch that user's
      // file and import it into the attacker's account. Keys from
      // `storage.getUploadUrl` are always scoped to
      // `temp/file-import/{userId}/...`.
      const expectedPrefix = `temp/file-import/${ctx.userId}/`;
      if (!input.r2Key.startsWith(expectedPrefix) || input.r2Key.includes('..')) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Upload key does not belong to the current user',
        });
      }
      fileImportLogger.info(
        {
          userId: ctx.userId,
          accountId: input.accountId,
          r2Key: input.r2Key,
          requestId: input.requestId,
        },
        'Enqueuing file-import job'
      );
      const jobId = await Container.get(BullMqEnqueueService).add(FILE_IMPORT, {
        userId: ctx.userId,
        requestId: input.requestId,
        r2Key: input.r2Key,
        fileType: input.fileType,
        accountId: input.accountId,
        enrich: true,
        defaultCurrency: input.defaultCurrency,
      });
      return { jobId };
    }),
});
