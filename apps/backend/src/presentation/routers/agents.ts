/**
 * Agents tRPC router
 *
 * Handles the "identity bridge" flow: a regular Scani user can claim an
 * agentic account (created autonomously by an AI agent via `agent_register`)
 * and consolidate its financial data into their own account.
 *
 * Endpoints:
 *   agents.claimAgentIdentity  – link an agent API key to the current user
 *   agents.listLinkedAgents    – list agents already linked to the current user
 */

import { AgenticUserService } from '@scani/core/services/AgenticUserService';
import { ApiKeyService } from '@scani/core/services/ApiKeyService';
import { Container } from 'typedi';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const agenticUserService = Container.get(AgenticUserService);
const apiKeyService = Container.get(ApiKeyService);

export const agentsRouter = router({
  /**
   * Claim an agent identity by linking the agent's API key to the current user.
   *
   * Flow:
   *   1. User authenticates via Supabase (normal web login)
   *   2. User enters the agent's API key in Settings → Linked AI Agents
   *   3. Backend validates the key, resolves the agentic userId, and links it
   *   4. The agent's accounts/holdings become visible in the user's portfolio
   */
  claimAgentIdentity: protectedProcedure
    .input(
      z.object({
        agentApiKey: z.string().min(1).describe("The agent's API key (sk_live_...)"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      // Validate the agent's API key and resolve the agentic user ID
      const validatedKey = await apiKeyService.validateApiKey(input.agentApiKey);

      // Link the agentic user to the current regular user
      return agenticUserService.linkAgentToUser({
        agentId: validatedKey.userId,
        targetUserId: dbUser.id,
      });
    }),

  /** List all agentic users linked to the current user */
  listLinkedAgents: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return agenticUserService.getLinkedAgents(dbUser.id);
  }),
});
