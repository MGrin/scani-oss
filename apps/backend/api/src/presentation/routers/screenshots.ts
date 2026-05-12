import { AccountRepository } from '@scani/domain/repositories';
import { SCREENSHOT_PARSE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { BullMqEnqueueService } from '@scani/queue';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';

const screenshotsLogger = createComponentLogger('router:screenshots');

/**
 * R2 keys come from the client, but `storage.getUploadUrl` scopes them to
 * `temp/{purpose}/{userId}/{uuid}.{ext}`. Without re-validating the prefix
 * here, a caller could submit another user's leaked key (from logs, client
 * telemetry, a replay attack) and have *that* user's screenshot parsed into
 * the attacker's account. This guard enforces the invariant that the key
 * belongs to the caller, and rejects any `..` segment defensively.
 */
function assertOwnedKey(key: string, userId: string, purpose: 'screenshot' | 'file-import'): void {
  const expectedPrefix = `temp/${purpose}/${userId}/`;
  if (!key.startsWith(expectedPrefix) || key.includes('..')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Upload key does not belong to the current user',
    });
  }
}

export const screenshotsRouter = router({
  /**
   * Parse N screenshots asynchronously via BullMQ.
   *
   * The client uploads each image to R2 via a presigned URL from
   * `storage.getUploadUrl`, then calls this mutation with the returned
   * `r2Keys`. This mutation only enqueues the parse work and returns a
   * jobId — the UI subscribes to job completion via WebSocket
   * (`RealTimeUpdatesService`) or polls `jobs.status` as a fallback.
   *
   * Prior behaviour (inline AI calls in this mutation) is intentionally
   * removed — per-file AI provider calls can take 3–10 seconds each and
   * parallelizing 10 of them inside a request timed out in practice.
   */
  parseScreenshots: protectedProcedure
    .input(
      z.object({
        r2Keys: z.array(z.string().min(1)).min(1, 'At least one file is required').max(10),
        provider: z.literal('openai').optional(),
        accountType: z.string().optional(),
        expectedCurrency: z.string().optional(),
        context: z.string().optional(),
        minConfidence: z.number().min(0).max(1).default(0.5),
        accountId: z.string().optional(),
        requestId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      for (const key of input.r2Keys) {
        assertOwnedKey(key, ctx.userId, 'screenshot');
      }
      // When the caller pins the screenshot to a specific account,
      // enforce the account belongs to them. The downstream use case
      // trusts `accountId` from the payload; without this guard an
      // attacker could pair their own r2Keys with a victim's accountId
      // and force-write holdings under the victim's account.
      if (input.accountId) {
        const account = await Container.get(AccountRepository).findByIdAndUser(
          input.accountId,
          ctx.userId
        );
        if (!account) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Account does not belong to the current user',
          });
        }
      }
      screenshotsLogger.info(
        { fileCount: input.r2Keys.length, provider: input.provider, requestId: input.requestId },
        'Enqueuing screenshot parse job'
      );
      const jobId = await Container.get(BullMqEnqueueService).add(SCREENSHOT_PARSE, {
        userId: ctx.userId,
        requestId: input.requestId,
        r2Keys: input.r2Keys,
        provider: input.provider ?? 'openai',
        accountType: input.accountType ?? 'unknown',
        expectedCurrency: input.expectedCurrency ?? 'USD',
        context: input.context,
        minConfidence: input.minConfidence,
        accountId: input.accountId,
      });
      return { jobId };
    }),
});
