import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewUserIntegrationCredentials, UserIntegrationCredentials } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, gt, isNotNull, or, sql } from 'drizzle-orm';
import { Service } from 'typedi';

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
    transaction?: DatabaseTransaction,
    limit?: number
  ): Promise<UserIntegrationCredentials[]> {
    const database = this.getDb(transaction);
    // Two explicit param casts needed for this query to run under Drizzle
    // + postgres.js:
    //   1. `::credentials_import_status` — string literals bind as `text`
    //      and Postgres refuses to compare an enum column to `text`.
    //   2. `::timestamptz` on a stringified Date — Drizzle's sql template
    //      feeds `Date` through a serializer that throws
    //      "The string argument must be of type string" before the driver
    //      ever sees the row. Passing `cutoff.toISOString()` sidesteps it.
    const cutoffIso = cutoff.toISOString();
    const query = database
      .select()
      .from(schema.userIntegrationCredentials)
      .where(
        and(
          sql`${schema.userIntegrationCredentials.importStatus} = ${'pending_enqueue'}::credentials_import_status`,
          sql`(${schema.userIntegrationCredentials.importEnqueuedAt} IS NULL OR ${schema.userIntegrationCredentials.importEnqueuedAt} < ${cutoffIso}::timestamptz)`
        )
      );
    return typeof limit === 'number' && limit > 0 ? query.limit(limit) : query;
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
   * Record that a scheduled sync was REFUSED by the provider (SC-279).
   *
   * Separate from `markImportFailed` on purpose. That one belongs to the
   * import lifecycle and bumps `importRetryCount`, which
   * `reconcile-pending-credentials` reads to decide a credential is beyond
   * help — so an hourly balance failure writing there would abandon a later,
   * unrelated import before it had been tried once.
   *
   * `blockedUntil` is the window the provider attached, when it attached one.
   * While it is in the future the sync must not contact the provider for this
   * credential at all; for a lockout the attempt is itself the harm.
   */
  async markSyncRefused(
    id: string,
    errorMessage: string,
    blockedUntil: Date | null,
    transaction?: DatabaseTransaction
  ): Promise<UserIntegrationCredentials | undefined> {
    const database = this.getDb(transaction);
    const results = await database
      .update(schema.userIntegrationCredentials)
      .set({
        syncLastError: errorMessage.slice(0, 2000),
        syncFailureCount: sql`${schema.userIntegrationCredentials.syncFailureCount} + 1`,
        ...(blockedUntil ? { syncBlockedUntil: blockedUntil } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.userIntegrationCredentials.id, id))
      .returning();
    return results[0];
  }

  /**
   * A scheduled sync succeeded — clear the refusal so the row stops claiming
   * one. Only writes when there is something to clear, so an ordinary hourly
   * success does not churn `updated_at` on every credential.
   */
  async clearSyncRefusal(
    id: string,
    transaction?: DatabaseTransaction
  ): Promise<UserIntegrationCredentials | undefined> {
    const database = this.getDb(transaction);
    const results = await database
      .update(schema.userIntegrationCredentials)
      .set({
        syncBlockedUntil: null,
        syncLastError: null,
        syncFailureCount: 0,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.userIntegrationCredentials.id, id),
          or(
            isNotNull(schema.userIntegrationCredentials.syncBlockedUntil),
            isNotNull(schema.userIntegrationCredentials.syncLastError),
            gt(schema.userIntegrationCredentials.syncFailureCount, 0)
          )
        )
      )
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
