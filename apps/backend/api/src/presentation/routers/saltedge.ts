import { SaltEdgeConnectionService } from '@scani/domain/services/integrations/SaltEdgeConnectionService';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { loadEnv } from '../../config/env';
import { protectedProcedure, router } from '../trpc';

/**
 * Linking a bank through Salt Edge's hosted widget (SC-1244).
 *
 * The return URL is decided here, never taken from the client: a
 * caller-supplied one would make this an open redirect through Salt Edge.
 */
function returnTo(): string {
  return `${loadEnv().FRONTEND_URL.replace(/\/$/, '')}/integrations/saltedge/return`;
}

function asTrpcError(error: unknown): unknown {
  if (error instanceof Error && /not configured/.test(error.message)) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message });
  }
  if (error instanceof Error && /connection not found/.test(error.message)) {
    return new TRPCError({ code: 'NOT_FOUND', message: error.message });
  }
  return error;
}

export const saltedgeRouter = router({
  startConnect: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      const connectUrl = await Container.get(SaltEdgeConnectionService).startConnect(
        ctx.userId,
        returnTo()
      );
      return { connectUrl };
    } catch (error) {
      throw asTrpcError(error);
    }
  }),

  /** The caller's linked banks, and which of them need consent renewed. */
  connections: protectedProcedure.query(({ ctx }) =>
    Container.get(SaltEdgeConnectionService).listConnections(ctx.userId)
  ),

  startReconnect: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const connectUrl = await Container.get(SaltEdgeConnectionService).startReconnect(
          ctx.userId,
          input.connectionId,
          returnTo()
        );
        return { connectUrl };
      } catch (error) {
        throw asTrpcError(error);
      }
    }),
});
