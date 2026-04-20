import { ParseScreenshotUseCase } from '@scani/domain/use-cases/ParseScreenshotUseCase';
import { createComponentLogger } from '@scani/logging';
import type { ScreenshotParseJob } from '@scani/queue';
import { deleteTempBlob, readTempBlob } from '@scani/storage';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { Container } from 'typedi';
import { z } from 'zod';
import { createUserJobProcessor } from '../lib/processor-wrapper';

const logger = createComponentLogger('processor:screenshot-parse');

const payloadSchema: z.ZodType<ScreenshotParseJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  r2Keys: z.array(z.string().min(1)).min(1).max(10),
  provider: z.string().min(1),
  accountType: z.string().min(1),
  expectedCurrency: z.string().min(1),
  context: z.string().optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  accountId: z.string().optional(),
});

export function buildScreenshotParseProcessor(publisher: Redis): (job: Job) => Promise<unknown> {
  return createUserJobProcessor({
    name: 'screenshot-parse',
    schema: payloadSchema,
    publisher,
    handler: async (data, ctx) => {
      const useCase = Container.get(ParseScreenshotUseCase);
      const results: Array<{
        r2Key: string;
        success: boolean;
        data?: Awaited<ReturnType<typeof useCase.execute>>;
        error?: string;
      }> = [];

      for (let i = 0; i < data.r2Keys.length; i++) {
        const key = data.r2Keys[i];
        if (!key) continue;
        try {
          const buf = await readTempBlob(key);
          const mimeType = inferMime(key);
          const parsed = await useCase.execute({
            imageBase64: buf.toString('base64'),
            mimeType,
            provider: data.provider as 'openai' | 'perplexity' | 'deepseek',
            accountType: data.accountType,
            expectedCurrency: data.expectedCurrency,
            context: data.context,
            minConfidence: data.minConfidence,
            accountId: data.accountId,
            userId: data.userId,
          });
          results.push({ r2Key: key, success: true, data: parsed });
        } catch (err) {
          results.push({
            r2Key: key,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
          logger.error(
            { jobId: ctx.job.id, r2Key: key, error: err instanceof Error ? err.message : err },
            'Screenshot parse failed for one file'
          );
        } finally {
          // R2 lifecycle rule will clean up if this fails.
          void deleteTempBlob(key).catch(() => undefined);
        }
        await ctx.reportProgress((i + 1) / data.r2Keys.length);
      }

      const successCount = results.filter((r) => r.success).length;
      return {
        results,
        // Echo accountId from the payload so the job detail page can
        // render the review-and-save card against the same account the
        // user picked at upload time. Without this, a user who
        // navigated away mid-parse would have no way to resume the
        // import.
        accountId: data.accountId ?? null,
        summary: {
          totalFiles: data.r2Keys.length,
          successCount,
          failureCount: data.r2Keys.length - successCount,
        },
      };
    },
  });
}

function inferMime(key: string): string | undefined {
  const ext = key.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    default:
      return undefined;
  }
}
