/**
 * File import router
 * Handles bank statement file parsing and preview
 */

import { BANK_TEMPLATES, parseStatement } from '@scani/core/external-services/file-import';
import { createComponentLogger } from '@scani/core/utils/logger';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';

const fileImportLogger = createComponentLogger('router:file-import');

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

      const result = await parseStatement(
        decoded,
        input.filename,
        input.bankTemplate,
        input.customMapping
      );

      fileImportLogger.info(
        {
          filename: input.filename,
          format: result.format,
          bankTemplate: result.bankTemplate,
          transactionCount: result.transactions.length,
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
        format: result.format,
        bankTemplate: result.bankTemplate ?? null,
        detectedCurrency: result.detectedCurrency ?? null,
        warnings: result.warnings,
        totalCount: result.transactions.length,
      };
    }),
});
