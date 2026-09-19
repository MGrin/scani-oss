import { SaltEdgeConnectionService } from '@scani/domain/services/integrations/SaltEdgeConnectionService';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { loadEnv } from '../../config/env';
import { protectedProcedure, router } from '../trpc';

/**
 * Linking a bank through Salt Edge's hosted widget (SC-1244).
 *
 * The return URL is decided here, never taken from the client: a
 * caller-supplied one would make this an open redirect through Salt Edge.
 */
export const saltedgeRouter = router({
  startConnect: protectedProcedure.mutation(async ({ ctx }) => {
    const returnTo = `${loadEnv().FRONTEND_URL.replace(/\/$/, '')}/integrations/saltedge/return`;
    try {
      const connectUrl = await Container.get(SaltEdgeConnectionService).startConnect(
        ctx.userId,
        returnTo
      );
      return { connectUrl };
    } catch (error) {
      if (error instanceof Error && /not configured/.test(error.message)) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message });
      }
      throw error;
    }
  }),
});
