import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';

export const aiChatRouter = router({
  sendMessage: protectedProcedure
    .input(
      z.object({
        scheduleId: z.string().uuid(),
        message: z.string().min(1).max(5000),
        conversationId: z.string().uuid().optional(),
      })
    )
    .mutation(async () => {
      throw new Error('TODO: Not implemented');
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
    .query(async () => {
      throw new Error('TODO: Not implemented');
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
    .mutation(async () => {
      throw new Error('TODO: Not implemented');
    }),
});
