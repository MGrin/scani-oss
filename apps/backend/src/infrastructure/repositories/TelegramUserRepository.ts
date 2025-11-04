import { eq } from 'drizzle-orm';
import { Service } from 'typedi';
import { db } from '../database/connection';
import type { NewTelegramUser, TelegramUser } from '../database/schema';
import { telegramUsers } from '../database/schema';

@Service()
export class TelegramUserRepository {
  /**
   * Find telegram user by telegram ID
   */
  async findByTelegramId(telegramId: string): Promise<TelegramUser | null> {
    const results = await db
      .select()
      .from(telegramUsers)
      .where(eq(telegramUsers.telegramId, telegramId))
      .limit(1);

    return results[0] || null;
  }

  /**
   * Find telegram user by Scani user ID
   */
  async findByUserId(userId: string): Promise<TelegramUser | null> {
    const results = await db
      .select()
      .from(telegramUsers)
      .where(eq(telegramUsers.userId, userId))
      .limit(1);

    return results[0] || null;
  }

  /**
   * Create new telegram user mapping
   */
  async create(data: NewTelegramUser): Promise<TelegramUser> {
    const results = await db.insert(telegramUsers).values(data).returning();

    if (!results[0]) {
      throw new Error('Failed to create telegram user');
    }

    return results[0];
  }

  /**
   * Update last interaction timestamp
   */
  async updateLastInteraction(telegramId: string): Promise<void> {
    await db
      .update(telegramUsers)
      .set({
        lastInteractionAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(telegramUsers.telegramId, telegramId));
  }

  /**
   * Deactivate telegram user
   */
  async deactivate(telegramId: string): Promise<void> {
    await db
      .update(telegramUsers)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(telegramUsers.telegramId, telegramId));
  }

  /**
   * Activate telegram user
   */
  async activate(telegramId: string): Promise<void> {
    await db
      .update(telegramUsers)
      .set({
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(telegramUsers.telegramId, telegramId));
  }
}
