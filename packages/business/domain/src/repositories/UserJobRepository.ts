import type { DatabaseTransaction } from '@scani/db';
import { getDb as getDbConnection } from '@scani/db/connection';
import type { UserJob, UserJobState } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Service } from 'typedi';

/**
 * Durable mirror of user-initiated BullMQ jobs.
 *
 * The backend's `enqueueJob` helper inserts a row here *before* calling
 * `queue.add`, so the worker's lifecycle writes (below) always find their
 * target row. Worker writes go DB-first and only then publish the WS event:
 * inverting that order would leak phantom-completed events to UI clients
 * while the row still says `active`.
 *
 * Enum binding: `schema.userJobStateEnum` is declared as a `pgEnum` so that
 * `eq(userJobs.state, 'active')` binds `$1` as `user_job_state` instead of
 * `text`. Without that binding Postgres refuses `user_job_state = text`
 * (same trap that bit the credentials reconciler in migration 0046).
 */
@Service()
export class UserJobRepository {
  private getDb(transaction?: DatabaseTransaction) {
    return transaction ?? getDbConnection();
  }

  /**
   * Insert a newly-enqueued job. Idempotent on `job_id` (PK) because BullMQ
   * dedupes `queue.add` calls with the same jobId — the wrapper may retry
   * the enqueue and we don't want the second call to 409.
   */
  async insertEnqueued(
    input: {
      jobId: string;
      userId: string;
      jobName: string;
      payloadSummary: Record<string, unknown>;
      attemptsAllowed: number;
    },
    transaction?: DatabaseTransaction
  ): Promise<void> {
    const db = this.getDb(transaction);
    await db
      .insert(schema.userJobs)
      .values({
        jobId: input.jobId,
        userId: input.userId,
        jobName: input.jobName,
        state: 'queued',
        payloadSummary: input.payloadSummary,
        attemptsAllowed: input.attemptsAllowed,
      })
      .onConflictDoNothing({ target: schema.userJobs.jobId });
  }

  /** Worker picked up the job; mark active + stamp startedAt. */
  async markActive(
    jobId: string,
    attemptsMade: number,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    const db = this.getDb(transaction);
    await db
      .update(schema.userJobs)
      .set({
        state: 'active',
        attemptsMade,
        startedAt: sql`COALESCE(${schema.userJobs.startedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(eq(schema.userJobs.jobId, jobId));
  }

  async updateProgress(
    jobId: string,
    progress: number,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    const clamped = Math.max(0, Math.min(1, progress));
    const db = this.getDb(transaction);
    await db
      .update(schema.userJobs)
      .set({
        state: 'progress',
        progress: clamped,
        updatedAt: new Date(),
      })
      .where(eq(schema.userJobs.jobId, jobId));
  }

  async markCompleted(
    jobId: string,
    result: unknown,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    const db = this.getDb(transaction);
    await db
      .update(schema.userJobs)
      .set({
        state: 'completed',
        progress: 1,
        // biome-ignore lint/suspicious/noExplicitAny: jsonb accepts any JSON-serializable value
        result: result as any,
        error: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      // Skip when state is already terminal — protects user-initiated
      // cancellation (markCancelled sets state='failed') from being
      // overwritten by a worker that finishes after the user clicks
      // Cancel.
      .where(
        and(
          eq(schema.userJobs.jobId, jobId),
          inArray(schema.userJobs.state, ['queued', 'active', 'progress'])
        )
      );
  }

  async markFailed(
    jobId: string,
    error: string,
    meta: { attemptsMade: number; attemptsAllowed: number },
    transaction?: DatabaseTransaction
  ): Promise<void> {
    const db = this.getDb(transaction);
    await db
      .update(schema.userJobs)
      .set({
        state: 'failed',
        error: error.slice(0, 4000), // keep row small; full error lives in worker logs / Sentry
        attemptsMade: meta.attemptsMade,
        attemptsAllowed: meta.attemptsAllowed,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      // See note on markCompleted — same guard so a post-cancel worker
      // failure doesn't overwrite the cancellation reason.
      .where(
        and(
          eq(schema.userJobs.jobId, jobId),
          inArray(schema.userJobs.state, ['queued', 'active', 'progress'])
        )
      );
  }

  /**
   * User-initiated cancellation. Locks the row into state='failed' with
   * a sentinel error message. Returns true on success, false when the
   * job is already in a terminal state (so the API can return a clear
   * "already finished" message).
   */
  async markCancelled(
    userId: string,
    jobId: string,
    transaction?: DatabaseTransaction
  ): Promise<boolean> {
    const db = this.getDb(transaction);
    const updated = await db
      .update(schema.userJobs)
      .set({
        state: 'failed',
        error: 'Cancelled by user',
        finishedAt: new Date(),
        updatedAt: new Date(),
        // Stamp action_taken_at too so the cancelled row drops out of
        // the "needs review" sidebar bucket immediately.
        actionTakenAt: sql`COALESCE(${schema.userJobs.actionTakenAt}, now())`,
      })
      .where(
        and(
          eq(schema.userJobs.jobId, jobId),
          eq(schema.userJobs.userId, userId),
          inArray(schema.userJobs.state, ['queued', 'active', 'progress'])
        )
      )
      .returning({ jobId: schema.userJobs.jobId });
    return updated.length > 0;
  }

  /** Paginated list of jobs for a user; most recent first. */
  async findMine(
    userId: string,
    options: { state?: UserJobState; limit?: number; offset?: number },
    transaction?: DatabaseTransaction
  ): Promise<UserJob[]> {
    const db = this.getDb(transaction);
    const conditions = [eq(schema.userJobs.userId, userId)];
    if (options.state) {
      conditions.push(eq(schema.userJobs.state, options.state));
    }
    const rows = await db
      .select()
      .from(schema.userJobs)
      .where(and(...conditions))
      .orderBy(desc(schema.userJobs.createdAt))
      .limit(options.limit ?? 50)
      .offset(options.offset ?? 0);
    return rows as UserJob[];
  }

  /** Ownership-gated single-row lookup — for the /jobs/:jobId detail page. */
  async findOneMine(
    userId: string,
    jobId: string,
    transaction?: DatabaseTransaction
  ): Promise<UserJob | null> {
    const db = this.getDb(transaction);
    const [row] = await db
      .select()
      .from(schema.userJobs)
      .where(and(eq(schema.userJobs.jobId, jobId), eq(schema.userJobs.userId, userId)))
      .limit(1);
    return (row as UserJob | undefined) ?? null;
  }

  /**
   * One-shot stamp when the user consumes the follow-up action on a
   * job (e.g. confirms extracted holdings from a screenshot/PDF/CSV
   * parse). Idempotent: subsequent calls are no-ops because of the
   * `action_taken_at IS NULL` guard in the WHERE clause — prevents
   * double-imports even under rapid double-click.
   *
   * Returns the stamp actually persisted (whether from this call or a
   * prior one), or `null` if the job isn't owned by this user.
   */
  async markActionTaken(
    userId: string,
    jobId: string,
    transaction?: DatabaseTransaction
  ): Promise<Date | null> {
    const db = this.getDb(transaction);
    const [updated] = await db
      .update(schema.userJobs)
      .set({ actionTakenAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.userJobs.jobId, jobId),
          eq(schema.userJobs.userId, userId),
          sql`${schema.userJobs.actionTakenAt} IS NULL`
        )
      )
      .returning({ actionTakenAt: schema.userJobs.actionTakenAt });
    if (updated?.actionTakenAt) return updated.actionTakenAt;
    // Either already-stamped or not-my-job — re-read to disambiguate.
    const current = await this.findOneMine(userId, jobId, transaction);
    return current?.actionTakenAt ?? null;
  }

  /**
   * Reset a row back to `queued` — called by the tRPC retry endpoint
   * right after BullMQ's `job.retry()` moves the job back to the
   * waiting set. Clears the terminal timestamp + error so the /jobs UI
   * flips out of the "failed" bucket immediately; the worker's
   * processor-wrapper will overwrite state + timestamps on the next
   * attempt (markActive → markCompleted/markFailed).
   */
  async markRequeued(jobId: string, transaction?: DatabaseTransaction): Promise<void> {
    const db = this.getDb(transaction);
    await db
      .update(schema.userJobs)
      .set({
        state: 'queued',
        progress: 0,
        error: null,
        result: null,
        finishedAt: null,
        startedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.userJobs.jobId, jobId));
  }

  /**
   * Delete a failed job's mirror row. The /jobs UI exposes this so a
   * permanently-failing job can be cleared off the list rather than
   * just retried. Ownership-gated and limited to `state='failed'` so a
   * stray click can't drop an active job's row out from under the
   * worker's lifecycle writes.
   */
  async deleteFailed(
    userId: string,
    jobId: string,
    transaction?: DatabaseTransaction
  ): Promise<boolean> {
    const db = this.getDb(transaction);
    const deleted = await db
      .delete(schema.userJobs)
      .where(
        and(
          eq(schema.userJobs.jobId, jobId),
          eq(schema.userJobs.userId, userId),
          eq(schema.userJobs.state, 'failed')
        )
      )
      .returning({ jobId: schema.userJobs.jobId });
    return deleted.length > 0;
  }

  /** Count of in-flight jobs for the top-nav badge. */
  async countActive(userId: string, transaction?: DatabaseTransaction): Promise<number> {
    const db = this.getDb(transaction);
    // Use the partial index on (user_id) WHERE state IN (...)
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.userJobs)
      .where(
        and(
          eq(schema.userJobs.userId, userId),
          sql`${schema.userJobs.state} IN ('queued','active','progress')`
        )
      );
    return row?.count ?? 0;
  }

  // Most recent in-flight job (queued / active / progress) of the given
  // name for a user. Lets the API endpoints dedup repeated user clicks
  // by returning the existing jobId instead of enqueuing a duplicate
  // when one is already running for the same purpose.
  async findInFlightByName(
    userId: string,
    jobName: string,
    transaction?: DatabaseTransaction
  ): Promise<UserJob | null> {
    const db = this.getDb(transaction);
    const [row] = await db
      .select()
      .from(schema.userJobs)
      .where(
        and(
          eq(schema.userJobs.userId, userId),
          eq(schema.userJobs.jobName, jobName),
          sql`${schema.userJobs.state} IN ('queued','active','progress')`
        )
      )
      .orderBy(desc(schema.userJobs.createdAt))
      .limit(1);
    return (row as UserJob | undefined) ?? null;
  }

  /**
   * Find rows that have been `queued` longer than `olderThan`. Used by
   * the orphan reconciler: if the backend crashed between
   * `insertEnqueued` and `queue.add` we left a row sitting in `queued`
   * forever with no BullMQ entry backing it. The reconciler finds them
   * here and marks them `failed`.
   */
  async findOrphanedQueued(olderThan: Date, transaction?: DatabaseTransaction): Promise<UserJob[]> {
    const db = this.getDb(transaction);
    const cutoffIso = olderThan.toISOString();
    const rows = await db
      .select()
      .from(schema.userJobs)
      .where(
        and(
          sql`${schema.userJobs.state} = 'queued'::user_job_state`,
          sql`${schema.userJobs.createdAt} < ${cutoffIso}::timestamptz`
        )
      )
      .limit(500);
    return rows as UserJob[];
  }
}
