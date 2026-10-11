import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import {
  AgentWriteBusyError,
  AgentWriteJournal,
  AgentWriteNotFoundError,
  AgentWriteUndoError,
} from '../../agent-writes/journal';
import { ConnectedAppsService } from '../../auth/oauth-connector';
import {
  PersonalAccessTokenLimitError,
  PersonalAccessTokenService,
} from '../../auth/personal-access-tokens';
import { agentAccessAllowed } from '../../mcp/access-gate';
import { AgentCallLog } from '../../mcp/call-log';
import { enqueuePortfolioRollup } from '../lib/portfolio-rollup';
import { strictInput } from '../lib/strict-input';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

/**
 * Personal access tokens for the user's own AI agent (SC-1614), managed from
 * Settings. Every procedure but `status` refuses while agent access is off
 * for the caller.
 */
async function requireAgentAccess(userId: string): Promise<void> {
  if (!(await agentAccessAllowed(userId))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Agent access is not enabled' });
  }
}

const tokens = () => Container.get(PersonalAccessTokenService);
const apps = () => Container.get(ConnectedAppsService);
const journal = () => Container.get(AgentWriteJournal);

export const agentTokensRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return { enabled: await agentAccessAllowed(dbUser.id) };
  }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    await requireAgentAccess(dbUser.id);
    return tokens().list(dbUser.id);
  }),

  create: protectedProcedure
    .input(
      strictInput(
        z.object({
          name: z.string().trim().min(1).max(60),
          allowWrites: z.boolean().optional(),
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      await requireAgentAccess(dbUser.id);
      try {
        return await tokens().create(dbUser.id, input.name, { allowWrites: input.allowWrites });
      } catch (error) {
        if (error instanceof PersonalAccessTokenLimitError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
        }
        throw error;
      }
    }),

  revoke: protectedProcedure
    .input(strictInput(z.object({ id: z.string().uuid() })))
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      await requireAgentAccess(dbUser.id);
      if (!(await tokens().revoke(dbUser.id, input.id))) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Token not found' });
      }
      return { revoked: true };
    }),

  // Apps connected through OAuth (SC-1615). Not gated on agent access: a
  // user must always be able to see and cut off what can read their data.
  connectedApps: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return apps().list(dbUser.id);
  }),

  disconnectApp: protectedProcedure
    .input(strictInput(z.object({ clientId: z.string().min(1).max(200) })))
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      if (!(await apps().revoke(dbUser.id, input.clientId))) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'App not found' });
      }
      return { disconnected: true };
    }),

  // What agents changed (SC-1617). Not gated on agent access, for the same
  // reason as `connectedApps`: the record of what happened outlives the switch.
  activity: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return journal().list(dbUser.id);
  }),

  // Every tool call an agent made (SC-1618). Ungated, as `activity`.
  calls: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return Container.get(AgentCallLog).list(dbUser.id);
  }),

  /** From Settings, or from an agent holding the write scope. */
  undoWrite: protectedProcedure
    .input(strictInput(z.object({ id: z.string().uuid() })))
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      try {
        const outcome = await journal().undo(dbUser.id, input.id, ctx.agentTokenId ?? 'app');
        void enqueuePortfolioRollup(dbUser.id);
        return { undone: true, restoredRows: outcome.restored };
      } catch (error) {
        if (error instanceof AgentWriteNotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        }
        if (error instanceof AgentWriteUndoError) {
          throw new TRPCError({ code: 'CONFLICT', message: error.message });
        }
        if (error instanceof AgentWriteBusyError) {
          throw new TRPCError({ code: 'CONFLICT', message: error.message });
        }
        throw error;
      }
    }),
});
