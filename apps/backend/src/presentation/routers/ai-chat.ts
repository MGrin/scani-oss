import { z } from 'zod';
import { ScheduleAgentService } from '../../infrastructure/voltagent/ScheduleAgentService';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

// Singleton instance of the VoltAgent service
const agentService = new ScheduleAgentService();

/**
 * AI Chat Router
 *
 * Provides tRPC endpoints for AI-powered chat interactions
 * Currently focused on schedule step configuration
 */
export const aiChatRouter = router({
  /**
   * Send a message to the AI agent and get a response
   */
  sendMessage: protectedProcedure
    .input(
      z.object({
        scheduleId: z.string().uuid(),
        message: z.string().min(1).max(5000),
        conversationId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);

      // Send message to VoltAgent with PostgreSQL memory persistence
      const response = await agentService.sendMessage({
        userId: dbUser.id,
        scheduleId: input.scheduleId,
        message: input.message,
        conversationId: input.conversationId,
      });

      return response;
    }),

  /**
   * Get conversation history for a schedule
   */
  getConversation: protectedProcedure
    .input(
      z.object({
        scheduleId: z.string().uuid(),
        conversationId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);

      // Retrieve conversation history from VoltAgent PostgreSQL memory
      const messages = await agentService.getConversation({
        userId: dbUser.id,
        conversationId: input.conversationId,
      });

      return messages;
    }),

  /**
   * Clear conversation history
   */
  clearConversation: protectedProcedure
    .input(
      z.object({
        conversationId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);

      // Clear conversation from VoltAgent PostgreSQL memory
      const success = await agentService.clearConversation({
        userId: dbUser.id,
        conversationId: input.conversationId,
      });

      return { success };
    }),
});

/**
 * Initialize VoltAgent memory tables on module load
 * This ensures tables exist before the router is used
 */
agentService.initializeMemoryTables().catch((error) => {
  console.error('Failed to initialize VoltAgent memory tables:', error);
});
