/**
 * DailyPortfolioDigestCronJob
 *
 * Cron job that runs daily at midnight UTC to send AI-generated portfolio overview
 * and insights to all users with connected Telegram accounts.
 *
 * Schedule: Every day at 00:00 UTC (midnight)
 */

import { eq } from 'drizzle-orm';
import { createComponentLogger } from '../../utils/logger';
import { db } from '../database/connection';
import { telegramUsers } from '../database/schema';

const logger = createComponentLogger('cron:daily-portfolio-digest');

/**
 * Execute the daily portfolio digest cron job
 * This function is called by the backend cron scheduler and delegates
 * the actual digest generation and Telegram messaging to the telegram-bot service.
 * The telegram-bot service uses AI to generate personalized, engaging digest messages.
 */
export async function executeDailyPortfolioDigestCronJob(telegramBotService?: {
  sendDailyDigestToAllUsers: (params: {
    getActiveTelegramUsers: () => Promise<
      Array<{ id: string; telegramId: string; userId: string }>
    >;
    updateLastInteraction: (telegramUserId: string) => Promise<void>;
  }) => Promise<{
    successCount: number;
    errorCount: number;
    errors: Array<{ telegramId: string; error: string }>;
  }>;
}): Promise<void> {
  const startTime = Date.now();
  logger.info('🕐 Starting daily portfolio digest cron job');

  // Check if Telegram bot service is available
  if (!telegramBotService) {
    logger.warn('⚠️ Telegram bot service not available, skipping digest');
    return;
  }

  try {
    // Delegate to telegram bot service for AI-powered digest generation and sending
    const result = await telegramBotService.sendDailyDigestToAllUsers({
      getActiveTelegramUsers: async () => {
        const users = await db.select().from(telegramUsers).where(eq(telegramUsers.isActive, true));
        return users.map((u) => ({
          id: u.id,
          telegramId: u.telegramId,
          userId: u.userId,
        }));
      },
      updateLastInteraction: async (telegramUserId: string) => {
        await db
          .update(telegramUsers)
          .set({ lastInteractionAt: new Date() })
          .where(eq(telegramUsers.id, telegramUserId));
      },
    });

    const durationMs = Date.now() - startTime;

    logger.info(
      {
        successCount: result.successCount,
        errorCount: result.errorCount,
        durationMs,
      },
      '✅ Daily portfolio digest cron job completed'
    );

    // Log errors if any
    if (result.errors.length > 0) {
      logger.warn(
        {
          errors: result.errors.slice(0, 10), // Log first 10 errors only
          totalErrors: result.errors.length,
        },
        'Some users did not receive the daily digest'
      );
    }
  } catch (error) {
    const durationMs = Date.now() - startTime;
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        durationMs,
      },
      '❌ Daily portfolio digest cron job failed'
    );
    // Don't throw - let the cron job continue on next schedule
  }
}
