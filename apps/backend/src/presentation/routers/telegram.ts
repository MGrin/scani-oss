import { Container } from 'typedi';
import { z } from 'zod';
import { TelegramUserRepository } from '../../infrastructure/repositories/TelegramUserRepository';
import { TelegramAuthService } from '../../infrastructure/telegram/TelegramAuthService';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const telegramAuthService = Container.get(TelegramAuthService);
const telegramUserRepo = Container.get(TelegramUserRepository);

export const telegramRouter = router({
  /**
   * Link Telegram account to authenticated user
   * Called from the web app when user wants to connect Telegram
   */
  linkAccount: protectedProcedure
    .input(
      z.object({
        telegramId: z.string(),
        telegramUsername: z.string().optional(),
        authToken: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);

      const telegramUser = await telegramAuthService.linkTelegramUser(
        input.telegramId,
        input.telegramUsername,
        input.authToken
      );

      return {
        success: true,
        telegramUser: {
          id: telegramUser.id,
          telegramId: telegramUser.telegramId,
          telegramUsername: telegramUser.telegramUsername,
          createdAt: telegramUser.createdAt,
        },
      };
    }),

  /**
   * Check if user has linked Telegram account
   */
  getLinkedAccount: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);
    const telegramUser = await telegramUserRepo.findByUserId(dbUser.id);

    if (!telegramUser || !telegramUser.isActive) {
      return null;
    }

    return {
      id: telegramUser.id,
      telegramId: telegramUser.telegramId,
      telegramUsername: telegramUser.telegramUsername,
      lastInteractionAt: telegramUser.lastInteractionAt,
      createdAt: telegramUser.createdAt,
    };
  }),

  /**
   * Unlink Telegram account
   */
  unlinkAccount: protectedProcedure.mutation(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);
    const telegramUser = await telegramUserRepo.findByUserId(dbUser.id);

    if (!telegramUser) {
      return { success: false, message: 'No Telegram account linked' };
    }

    await telegramAuthService.unlinkTelegramUser(telegramUser.telegramId);

    return { success: true, message: 'Telegram account unlinked successfully' };
  }),
});
