import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { UserJobRepository } from '@scani/domain/repositories';
import { DocumentRetentionService, UploadedFileService } from '@scani/domain/services';
import { ParseScreenshotUseCase } from '@scani/domain/use-cases/ParseScreenshotUseCase';
import { SCREENSHOT_PARSE, type ScreenshotParseJob } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { type ProcessorContext, UserJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:screenshot-parse');

@Service()
export class ScreenshotParseProcessor extends UserJobProcessor<ScreenshotParseJob, unknown> {
  readonly descriptor = SCREENSHOT_PARSE;

  protected async handle(data: ScreenshotParseJob, ctx: ProcessorContext): Promise<unknown> {
    const useCase = Container.get(ParseScreenshotUseCase);
    const storage = Container.get(StorageFacade);
    const uploadedFiles = Container.get(UploadedFileService);
    const retention = Container.get(DocumentRetentionService);
    const results: Array<{
      r2Key: string;
      success: boolean;
      data?: Awaited<ReturnType<typeof useCase.execute>>;
      error?: string;
    }> = [];

    const total = data.r2Keys.length;
    for (let i = 0; i < total; i++) {
      const key = data.r2Keys[i];
      if (!key) continue;
      const fileLabel = total > 1 ? ` (${i + 1}/${total})` : '';
      try {
        await ctx.reportStatus(`Reading file${fileLabel}…`);
        const buf = await storage.read(key);
        const mimeType = inferMime(key);
        // Recorded and retained BEFORE the AI call: the user uploaded this
        // file whether or not the extractor can read it, and a screenshot
        // that failed to parse is exactly the one they want to look at
        // again.
        await this.record(uploadedFiles, data.userId, key, mimeType, buf, ctx.job.id);
        await ctx.reportStatus(`Extracting holdings with AI${fileLabel}…`);
        const parsed = await useCase.execute({
          imageBase64: buf.toString('base64'),
          mimeType,
          provider: data.provider as 'openai',
          accountType: data.accountType,
          expectedCurrency: data.expectedCurrency,
          context: data.context,
          minConfidence: data.minConfidence,
          accountId: data.accountId,
          userId: data.userId,
          onStatus: (msg) => ctx.reportStatus(msg),
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
        // Only ever the temp upload. `UploadedFileService` COPIES the file
        // to its permanent key, so deleting the key this job was handed is
        // what completes the promotion — but the guard is the retained-
        // prefix test rather than "temp keys only", exactly as in
        // `document-parse`: a future caller handed a stored key must not be
        // able to destroy the file we promised to keep.
        // R2 lifecycle rule will clean up if this fails.
        if (!retention.isRetained(key)) {
          void storage.delete(key).catch(() => undefined);
        }
      }
      await ctx.reportProgress((i + 1) / data.r2Keys.length);
    }

    const successCount = results.filter((r) => r.success).length;
    const totalExtracted = results.reduce(
      (n, r) => n + (r.success ? (r.data?.holdings?.length ?? 0) : 0),
      0
    );

    // Auto-stamp `action_taken_at` when there's nothing for the user to
    // review — every extractor failed, or the AI ran cleanly but found
    // zero holdings. Without this the job lands as `state=completed`
    // (BullMQ truthful: the worker returned without throwing) AND
    // `actionTakenAt=null`, which the topbar/sidebar /jobs badge counts
    // as "1 to review" (see @scani/shared REVIEWABLE_JOB_NAMES).
    // The contradiction confused users: the body card says "0 succeeded,
    // 1 failed" with a red warning, yet the badge insists there's
    // something actionable. There isn't — only re-uploading helps, and
    // that's a fresh job. Stamping here makes the badge silently drop
    // this job out of the action-required count.
    if (totalExtracted === 0) {
      const jobId = ctx.job.id;
      if (typeof jobId === 'string' && jobId.length > 0) {
        try {
          await Container.get(UserJobRepository).markActionTaken(data.userId, jobId);
        } catch (err) {
          logger.warn(
            { jobId, error: err instanceof Error ? err.message : err },
            'Failed to auto-stamp actionTakenAt for empty-result screenshot-parse (non-fatal)'
          );
        }
      }
    }

    return {
      results,
      // Echo accountId from the payload so the job detail page can
      // render the review-and-save card against the same account the
      // user picked at upload time.
      accountId: data.accountId ?? null,
      summary: {
        totalFiles: data.r2Keys.length,
        successCount,
        failureCount: data.r2Keys.length - successCount,
      },
    };
  }

  /**
   * Never throws. The user's goal is the parse; a failed bookkeeping write
   * must not turn a readable screenshot into a failed file. Mirrors
   * `DocumentParseProcessor.retain`, which swallows for the same reason.
   */
  private async record(
    uploadedFiles: UploadedFileService,
    userId: string,
    r2Key: string,
    mimeType: string | undefined,
    bytes: Buffer,
    jobId: string | undefined
  ): Promise<void> {
    try {
      await uploadedFiles.record({
        userId,
        purpose: 'screenshot',
        bytes: new Uint8Array(bytes),
        mimeType: mimeType ?? 'application/octet-stream',
        r2Key,
        originalFilename: filenameFromKey(r2Key),
      });
    } catch (err) {
      logger.warn(
        { jobId, r2Key, error: err instanceof Error ? err.message : err },
        'Screenshot upload could not be recorded (non-fatal)'
      );
    }
  }
}

// `screenshots.parseScreenshots` carries r2Keys and nothing else — the
// client never sends the picked filename — so the uploaded name is the
// generated one the presigner minted. Honest rather than invented.
function filenameFromKey(key: string): string {
  return key.split('/').pop() || key;
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
