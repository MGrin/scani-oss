import type { ParseScreenshotResult } from '@scani/core/use-cases/ParseScreenshotUseCase';
import { ParseScreenshotUseCase } from '@scani/core/use-cases/ParseScreenshotUseCase';
import { createComponentLogger } from '@scani/core/utils/logger';
import { Container } from 'typedi';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';

const screenshotsLogger = createComponentLogger('router:screenshots');

// Supported image file extensions
const SUPPORTED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;
type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

const parseScreenshotUseCase = Container.get(ParseScreenshotUseCase);

export const screenshotsRouter = router({
  // Parse multiple screenshots using AI
  parseScreenshots: protectedProcedure
    .input(
      z.object({
        files: z
          .array(
            z.object({
              filename: z.string().min(1, 'Filename is required'),
              data: z
                .string()
                .min(1, 'File data is required')
                .max(7_000_000, 'File too large (max ~5MB)'), // base64 encoded
              contentType: z.string().optional(),
            })
          )
          .min(1, 'At least one file is required')
          .max(10, 'Maximum 10 files allowed'),
        provider: z.enum(['openai', 'perplexity', 'deepseek']).optional(),
        accountType: z.string().optional(),
        expectedCurrency: z.string().optional(),
        context: z.string().optional(),
        minConfidence: z.number().min(0).max(1).default(0.5),
        accountId: z.string().optional(), // Account ID for existing holdings lookup
      })
    )
    .mutation(async ({ input, ctx }) => {
      screenshotsLogger.info(
        {
          fileCount: input.files.length,
          provider: input.provider,
          minConfidence: input.minConfidence,
        },
        'Starting batch screenshot parsing'
      );

      // Process all screenshots in parallel
      const filePromises = input.files.map(async (file) => {
        const startTime = Date.now();
        const result: {
          filename: string;
          success: boolean;
          data?: ParseScreenshotResult;
          error?: string;
          processingTime: number;
        } = {
          filename: file.filename,
          success: false,
          processingTime: 0,
        };

        try {
          // Validate file extension
          const extension = getFileExtension(file.filename);
          if (!isSupportedExtension(extension)) {
            result.error = `Unsupported file extension: ${extension}. Supported: ${SUPPORTED_EXTENSIONS.join(
              ', '
            )}`;
            screenshotsLogger.warn(
              { filename: file.filename, extension },
              'Unsupported file extension'
            );
            return result;
          }

          // Validate base64 data
          if (!isValidBase64(file.data)) {
            result.error = 'Invalid base64 data';
            screenshotsLogger.warn({ filename: file.filename }, 'Invalid base64 data');
            return result;
          }

          // Parse screenshot using ParseScreenshotUseCase
          const portfolio = await parseScreenshotUseCase.execute({
            imageBase64: file.data,
            provider: input.provider,
            accountType: input.accountType,
            expectedCurrency: input.expectedCurrency,
            context: input.context,
            minConfidence: input.minConfidence,
            accountId: input.accountId,
            userId: ctx.userId, // Get user ID from authenticated context
          });

          result.success = true;
          result.data = portfolio;
          result.processingTime = Date.now() - startTime;

          screenshotsLogger.info(
            {
              filename: file.filename,
              holdingsCount: portfolio.holdings.length,
              overallConfidence: portfolio.overallConfidence,
              processingTime: result.processingTime,
            },
            'Screenshot parsed successfully'
          );

          return result;
        } catch (error) {
          result.error = error instanceof Error ? error.message : 'Unknown error';
          result.processingTime = Date.now() - startTime;

          screenshotsLogger.error(
            {
              filename: file.filename,
              error: result.error,
              processingTime: result.processingTime,
            },
            'Screenshot parsing failed'
          );

          return result;
        }
      });

      // Wait for all screenshots to be processed in parallel
      const results = await Promise.all(filePromises);

      const successCount = results.filter((r) => r.success).length;
      const totalProcessingTime = results.reduce((sum, r) => sum + (r.processingTime || 0), 0);

      screenshotsLogger.info(
        {
          totalFiles: input.files.length,
          successCount,
          failureCount: input.files.length - successCount,
          totalProcessingTime,
          averageProcessingTime: totalProcessingTime / input.files.length,
        },
        'Batch screenshot parsing completed'
      );

      return {
        results,
        summary: {
          totalFiles: input.files.length,
          successCount,
          failureCount: input.files.length - successCount,
          totalProcessingTime,
          averageProcessingTime: Math.round(totalProcessingTime / input.files.length),
        },
      };
    }),
});

// Helper functions
function getFileExtension(filename: string): string {
  const parts = filename.toLowerCase().split('.');
  return parts.length > 1 ? parts[parts.length - 1] || '' : '';
}

function isSupportedExtension(extension: string): extension is SupportedExtension {
  return SUPPORTED_EXTENSIONS.includes(extension as SupportedExtension);
}

function isValidBase64(str: string): boolean {
  try {
    // Check if it's valid base64 by attempting to decode
    atob(str);
    return true;
  } catch {
    return false;
  }
}
