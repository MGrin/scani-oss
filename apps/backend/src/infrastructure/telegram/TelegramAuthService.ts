import { TRPCError } from '@trpc/server';
import { Container, Service } from 'typedi';
import { supabase } from '../../lib/supabase';
import type { TelegramUser } from '../database/schema';
import { TelegramUserRepository } from '../repositories/TelegramUserRepository';
import { UserContextService } from '../../application/services/UserContextService';

@Service()
export class TelegramAuthService {
  private readonly telegramUserRepo = Container.get(TelegramUserRepository);
  private readonly userContextService = Container.get(UserContextService);

  /**
   * Link a Telegram user to a Scani account using an auth token
   */
  async linkTelegramUser(
    telegramId: string,
    telegramUsername: string | undefined,
    authToken: string
  ): Promise<TelegramUser> {
    // Verify the auth token with Supabase
    const { data, error } = await supabase.auth.getUser(authToken);

    if (error || !data?.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Invalid authentication token',
      });
    }

    const supabaseUserId = data.user.id;

    // Ensure user exists in local database
    const dbUser = await this.userContextService.getOrCreateUser(data.user);

    // Check if Telegram user already exists
    const existingTelegramUser = await this.telegramUserRepo.findByTelegramId(telegramId);

    if (existingTelegramUser) {
      // Update existing mapping if user ID changed
      if (existingTelegramUser.userId !== dbUser.id) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This Telegram account is already linked to another user',
        });
      }

      // Reactivate if deactivated
      if (!existingTelegramUser.isActive) {
        await this.telegramUserRepo.activate(telegramId);
      }

      return existingTelegramUser;
    }

    // Create new telegram user mapping
    return this.telegramUserRepo.create({
      telegramId,
      telegramUsername: telegramUsername || null,
      userId: dbUser.id,
      isActive: true,
    });
  }

  /**
   * Get authenticated user from Telegram ID
   */
  async getAuthenticatedUser(telegramId: string): Promise<{ userId: string } | null> {
    const telegramUser = await this.telegramUserRepo.findByTelegramId(telegramId);

    if (!telegramUser || !telegramUser.isActive) {
      return null;
    }

    // Update last interaction timestamp
    await this.telegramUserRepo.updateLastInteraction(telegramId);

    return { userId: telegramUser.userId };
  }

  /**
   * Unlink Telegram account from user
   */
  async unlinkTelegramUser(telegramId: string): Promise<void> {
    await this.telegramUserRepo.deactivate(telegramId);
  }
}
