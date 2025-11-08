import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import * as schema from '../database/schema';
import type { NewUserIntegrationCredentials, UserIntegrationCredentials } from '../domain/entities';
import { BaseRepository, type DatabaseTransaction } from './BaseRepository';

@Service()
export class UserIntegrationCredentialsRepository extends BaseRepository<
  UserIntegrationCredentials,
  NewUserIntegrationCredentials
> {
  protected readonly table = schema.userIntegrationCredentials;
  protected readonly tableName = 'user_integration_credentials';

  /**
   * Find all credentials for a user
   */
  async findByUser(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<UserIntegrationCredentials[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select()
        .from(schema.userIntegrationCredentials)
        .where(
          and(
            eq(schema.userIntegrationCredentials.userId, userId),
            eq(schema.userIntegrationCredentials.isActive, true)
          )
        )
        .orderBy(schema.userIntegrationCredentials.createdAt);
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find credentials by user');
      throw error;
    }
  }

  /**
   * Find credentials by user and institution
   */
  async findByUserAndInstitution(
    userId: string,
    institutionId: string,
    transaction?: DatabaseTransaction
  ): Promise<UserIntegrationCredentials | undefined> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.userIntegrationCredentials)
        .where(
          and(
            eq(schema.userIntegrationCredentials.userId, userId),
            eq(schema.userIntegrationCredentials.institutionId, institutionId),
            eq(schema.userIntegrationCredentials.isActive, true)
          )
        )
        .limit(1);

      return results[0];
    } catch (error) {
      this.logger.error(
        { userId, institutionId, error },
        'Failed to find credentials by user and institution'
      );
      throw error;
    }
  }

  /**
   * Find all credentials by institution
   */
  async findByInstitution(
    institutionId: string,
    transaction?: DatabaseTransaction
  ): Promise<UserIntegrationCredentials[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select()
        .from(schema.userIntegrationCredentials)
        .where(
          and(
            eq(schema.userIntegrationCredentials.institutionId, institutionId),
            eq(schema.userIntegrationCredentials.isActive, true)
          )
        )
        .orderBy(schema.userIntegrationCredentials.createdAt);
    } catch (error) {
      this.logger.error({ institutionId, error }, 'Failed to find credentials by institution');
      throw error;
    }
  }

  /**
   * Find credentials by type
   */
  async findByType(
    userId: string,
    credentialsType: string,
    transaction?: DatabaseTransaction
  ): Promise<UserIntegrationCredentials[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select()
        .from(schema.userIntegrationCredentials)
        .where(
          and(
            eq(schema.userIntegrationCredentials.userId, userId),
            eq(schema.userIntegrationCredentials.credentialsType, credentialsType),
            eq(schema.userIntegrationCredentials.isActive, true)
          )
        )
        .orderBy(schema.userIntegrationCredentials.createdAt);
    } catch (error) {
      this.logger.error({ userId, credentialsType, error }, 'Failed to find credentials by type');
      throw error;
    }
  }

  /**
   * Update last used timestamp
   */
  async updateLastUsed(
    id: string,
    transaction?: DatabaseTransaction
  ): Promise<UserIntegrationCredentials | undefined> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .update(schema.userIntegrationCredentials)
        .set({ lastUsedAt: new Date() })
        .where(eq(schema.userIntegrationCredentials.id, id))
        .returning();

      return results[0];
    } catch (error) {
      this.logger.error({ id, error }, 'Failed to update last used timestamp');
      throw error;
    }
  }
}
