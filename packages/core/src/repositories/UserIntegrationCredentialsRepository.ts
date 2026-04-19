import { and, eq, sql } from 'drizzle-orm';
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

  /**
   * Find rows stuck in `pending_enqueue` whose `importEnqueuedAt` is older
   * than the cutoff (or whose `importEnqueuedAt` is null — which means the
   * backend crashed after storing but before the reconciler flag was set).
   * Used by the worker reconciler scheduler to sweep orphans.
   */
  async findPendingEnqueueOlderThan(
    cutoff: Date,
    transaction?: DatabaseTransaction
  ): Promise<UserIntegrationCredentials[]> {
    const database = this.getDb(transaction);
    return database
      .select()
      .from(schema.userIntegrationCredentials)
      .where(
        and(
          eq(schema.userIntegrationCredentials.importStatus, 'pending_enqueue'),
          sql`(${schema.userIntegrationCredentials.importEnqueuedAt} IS NULL OR ${schema.userIntegrationCredentials.importEnqueuedAt} < ${cutoff})`
        )
      );
  }

  /**
   * List rows in non-healthy import states (pending or failed) for admin UI.
   */
  async findUnhealthyImports(
    transaction?: DatabaseTransaction
  ): Promise<UserIntegrationCredentials[]> {
    const database = this.getDb(transaction);
    return database
      .select()
      .from(schema.userIntegrationCredentials)
      .where(sql`${schema.userIntegrationCredentials.importStatus} <> 'enqueued'`)
      .orderBy(schema.userIntegrationCredentials.updatedAt);
  }

  /**
   * Promote a row from pending_enqueue → enqueued with the BullMQ job id.
   */
  async markImportEnqueued(
    id: string,
    jobId: string,
    transaction?: DatabaseTransaction
  ): Promise<UserIntegrationCredentials | undefined> {
    const database = this.getDb(transaction);
    const results = await database
      .update(schema.userIntegrationCredentials)
      .set({
        importStatus: 'enqueued',
        importJobId: jobId,
        importEnqueuedAt: new Date(),
        importLastError: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.userIntegrationCredentials.id, id))
      .returning();
    return results[0];
  }

  /**
   * Mark an import failed with the error message; retry count is bumped so
   * the reconciler eventually gives up.
   */
  async markImportFailed(
    id: string,
    errorMessage: string,
    transaction?: DatabaseTransaction
  ): Promise<UserIntegrationCredentials | undefined> {
    const database = this.getDb(transaction);
    const results = await database
      .update(schema.userIntegrationCredentials)
      .set({
        importStatus: 'failed',
        importLastError: errorMessage.slice(0, 2000),
        importRetryCount: sql`${schema.userIntegrationCredentials.importRetryCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.userIntegrationCredentials.id, id))
      .returning();
    return results[0];
  }

  /**
   * Reset a failed row back to pending_enqueue so the reconciler (or an
   * admin-triggered retry) can have another go.
   */
  async resetImportToPending(
    id: string,
    transaction?: DatabaseTransaction
  ): Promise<UserIntegrationCredentials | undefined> {
    const database = this.getDb(transaction);
    const results = await database
      .update(schema.userIntegrationCredentials)
      .set({
        importStatus: 'pending_enqueue',
        importJobId: null,
        importEnqueuedAt: null,
        importLastError: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.userIntegrationCredentials.id, id))
      .returning();
    return results[0];
  }
}
