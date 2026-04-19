/**
 * Wallet Router
 * Handles crypto wallet import operations (async via BullMQ).
 */

import { WalletImplementations } from '@scani/core/features/implementations';
import { JOB_NAMES } from '@scani/core/queues';
import { createComponentLogger } from '@scani/core/utils/logger';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { enqueueJob } from '../../queues/enqueue';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const logger = createComponentLogger('router:wallet');

const ImportWalletSchema = z.object({
  address: z.string().min(1, 'Wallet address is required').max(200, 'Wallet address is too long'),
  displayName: z.string().max(100, 'Display name is too long').optional(),
  chain: z.string().min(1).default('auto'),
  requestId: z.string().uuid(),
});

export const walletRouter = router({
  getSupportedChains: protectedProcedure.query(async ({ ctx }) => {
    return await WalletImplementations.getSupportedChains({ userId: ctx.userId }, {});
  }),

  /**
   * Enqueue a wallet import job. Returns a jobId; the UI tracks the job
   * via WebSocket / jobs.status. Chain detection + balance fetching +
   * pricing all happen on the worker — this path used to take 5–15s
   * inline.
   */
  importAddress: protectedProcedure.input(ImportWalletSchema).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    logger.info(
      { userId: dbUser.id, address: input.address, chain: input.chain, requestId: input.requestId },
      'Enqueuing wallet import job'
    );
    const jobId = await enqueueJob(JOB_NAMES.walletImport, {
      userId: dbUser.id,
      requestId: input.requestId,
      chain: input.chain,
      address: input.address,
      label: input.displayName,
    });
    return { jobId };
  }),

  /**
   * Synchronous chain detection — kept inline because it's a preview
   * step shown before the import mutation. Fast enough (1–3s) that
   * queuing would add perceived latency.
   */
  detectChains: protectedProcedure
    .input(
      z.object({
        address: z
          .string()
          .min(1, 'Wallet address is required')
          .max(200, 'Wallet address is too long'),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const result = await WalletImplementations.detectChains({ userId: ctx.userId }, input);
      if (result.totalChains === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message:
            'No wallet activity found on any supported chain. Check the address, or add blockchain-explorer API keys (ETHERSCAN_API_KEY, etc.) if the backend is missing them.',
        });
      }
      return result;
    }),
});
