import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import * as schema from '../database/schema';
import type { DatabaseTransaction } from './BaseRepository';
import { BaseRepository } from './BaseRepository';

export type ApiKey = typeof schema.apiKeys.$inferSelect;
export type NewApiKey = typeof schema.apiKeys.$inferInsert;

@Service()
export class ApiKeyRepository extends BaseRepository<ApiKey, NewApiKey> {
  protected readonly table = schema.apiKeys;
  protected readonly tableName = 'api_keys';

  /**
   * Find all API keys for a specific user
   */
  async findByUserId(userId: string, transaction?: DatabaseTransaction): Promise<ApiKey[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(this.table)
        .where(eq(this.table.userId, userId))
        .orderBy(this.table.createdAt);

      return results as ApiKey[];
    } catch (error) {
      this.logger.error(
        { userId, error: error instanceof Error ? error.message : error },
        'Failed to find API keys by user ID'
      );
      throw error;
    }
  }

  /**
   * Find an active API key by its prefix
   */
  async findActiveByPrefix(
    keyPrefix: string,
    transaction?: DatabaseTransaction
  ): Promise<ApiKey[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(this.table)
        .where(and(eq(this.table.keyPrefix, keyPrefix), eq(this.table.isActive, true)));

      return results as ApiKey[];
    } catch (error) {
      this.logger.error(
        { keyPrefix, error: error instanceof Error ? error.message : error },
        'Failed to find active API key by prefix'
      );
      throw error;
    }
  }

  /**
   * Update the last used timestamp for an API key
   */
  async updateLastUsed(id: string, transaction?: DatabaseTransaction): Promise<void> {
    try {
      const database = this.getDb(transaction);
      await database
        .update(this.table)
        .set({ lastUsedAt: new Date() })
        .where(eq(this.table.id, id));

      this.logger.debug({ id }, 'Updated API key last used timestamp');
    } catch (error) {
      this.logger.error(
        { id, error: error instanceof Error ? error.message : error },
        'Failed to update API key last used timestamp'
      );
      throw error;
    }
  }

  /**
   * Revoke (deactivate) an API key
   */
  async revoke(id: string, transaction?: DatabaseTransaction): Promise<ApiKey | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .update(this.table)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(this.table.id, id))
        .returning();

      if (!results[0]) {
        return null;
      }

      this.logger.debug({ id }, 'Revoked API key');
      return results[0] as ApiKey;
    } catch (error) {
      this.logger.error(
        { id, error: error instanceof Error ? error.message : error },
        'Failed to revoke API key'
      );
      throw error;
    }
  }

  /**
   * Find an API key by user ID and key ID
   */
  async findByUserAndKeyId(
    userId: string,
    keyId: string,
    transaction?: DatabaseTransaction
  ): Promise<ApiKey | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(this.table)
        .where(and(eq(this.table.userId, userId), eq(this.table.id, keyId)))
        .limit(1);

      return (results[0] as ApiKey) || null;
    } catch (error) {
      this.logger.error(
        { userId, keyId, error: error instanceof Error ? error.message : error },
        'Failed to find API key by user and key ID'
      );
      throw error;
    }
  }
}
