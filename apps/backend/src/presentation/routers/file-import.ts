/**
 * File import router
 * Handles bank statement file parsing and preview
 */

import { BANK_TEMPLATES, parseStatement } from '@scani/core/external-services/file-import';
import { ParseFileUseCase } from '@scani/core/use-cases/ParseFileUseCase';
import { createComponentLogger } from '@scani/core/utils/logger';
import { TRPCError } from '@trpc/server';
import Container from 'typedi';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';

const fileImportLogger = createComponentLogger('router:file-import');

/**
 * File parsing safety caps.
 *
 * Base64 inputs up to ~4 MB decode to ~3 MB of raw bytes, which in turn can
 * expand into much more heap (papaparse keeps multiple copies of each row
 * during parsing). Without post-parse limits, an adversarial CSV can still
 * push memory far beyond the input size. These caps are enforced AFTER
 * parsing to bound the final result regardless of how compressible the input
 * was.
 */
const MAX_PARSED_TRANSACTIONS = 10_000;
const MAX_DECODED_BYTES = 4 * 1024 * 1024; // 4 MB

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
    .mutation(async ({ input }) => {
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

      const result = await parseStatement(
        decoded,
        input.filename,
        input.bankTemplate,
        input.customMapping
      );

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
   * Parse a bank statement file and return enriched holdings ready for import.
   * This is the preferred endpoint — it enriches holdings with token IDs and
   * existing holding matches, similar to the screenshot parsing pipeline.
   */
  parseAndEnrich: protectedProcedure
    .input(
      z.object({
        content: z.string().min(1).max(4_000_000, 'File too large (max ~3MB)'),
        filename: z.string().min(1),
        bankTemplate: z.string().optional(),
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
        accountId: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      fileImportLogger.info(
        { filename: input.filename, bankTemplate: input.bankTemplate, accountId: input.accountId },
        'Parsing and enriching bank statement file'
      );

      // Decode base64 content
      let decoded: string;
      try {
        decoded = Buffer.from(input.content, 'base64').toString('utf-8');
      } catch {
        decoded = input.content;
      }

      const decodedBytes = Buffer.byteLength(decoded, 'utf-8');
      if (decodedBytes > MAX_DECODED_BYTES) {
        throw new TRPCError({
          code: 'PAYLOAD_TOO_LARGE',
          message: `Decoded file is too large (${decodedBytes} bytes, max ${MAX_DECODED_BYTES})`,
        });
      }

      const parseFileUseCase = Container.get(ParseFileUseCase);
      const result = await parseFileUseCase.execute({
        content: decoded,
        filename: input.filename,
        bankTemplate: input.bankTemplate,
        customMapping: input.customMapping,
        accountId: input.accountId,
        userId: ctx.userId,
      });

      fileImportLogger.info(
        {
          filename: input.filename,
          format: result.format,
          holdingCount: result.holdings.length,
          warningCount: result.warnings.length,
        },
        'File parsed and enriched successfully'
      );

      return {
        holdings: result.holdings.map((h) => ({
          symbol: h.symbol,
          name: h.name ?? null,
          balance: h.balance,
          confidence: h.confidence,
          notes: h.notes ?? null,
          tokenId: h.tokenId ?? null,
          holdingId: h.holdingId ?? null,
          existingBalance: h.existingBalance ?? null,
        })),
        format: result.format,
        warnings: result.warnings,
      };
    }),
});
