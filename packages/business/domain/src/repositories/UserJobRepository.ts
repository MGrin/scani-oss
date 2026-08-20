import type { DatabaseTransaction } from '@scani/db';
import { getDb as getDbConnection } from '@scani/db/connection';
import type { UserJob, UserJobState } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { REVIEWABLE_JOB_NAMES, type ReviewOutcome } from '@scani/shared';
import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
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
   * "The queue has given up on this job" (SC-153) — the write `markFailed`
   * could never make, because it fires on every failed attempt and cannot
   * see whether another is coming.
   *
   * Three things make this deliberately unlike `markFailed`:
   *
   * 1. **No state guard.** By the time this runs the row is normally already
   *    `failed` from the last attempt's write, so the usual
   *    `state IN ('queued','active','progress')` filter would drop it. It
   *    sets `state` too, because the row it most needs to correct is the one
   *    still reading `queued` — a payload that fails validation throws
   *    before any lifecycle event fires at all.
   * 2. **`dead_at IS NULL` instead.** First terminal write wins, which is
   *    what keeps a user's cancellation from being relabelled
   *    "retries_exhausted" by a worker that dies moments later.
   * 3. **`error` is only filled in if empty.** The per-attempt message is
   *    usually the more specific one.
   */
  async markDead(
    jobId: string,
    meta: {
      reason: string;
      error: string;
      attemptsMade: number;
      attemptsAllowed: number;
    },
    transaction?: DatabaseTransaction
  ): Promise<boolean> {
    const db = this.getDb(transaction);
    const now = new Date();
    const updated = await db
      .update(schema.userJobs)
      .set({
        state: 'failed',
        deadAt: now,
        failureReason: meta.reason,
        error: sql`COALESCE(${schema.userJobs.error}, ${meta.error.slice(0, 4000)})`,
        attemptsMade: meta.attemptsMade,
        attemptsAllowed: meta.attemptsAllowed,
        finishedAt: sql`COALESCE(${schema.userJobs.finishedAt}, ${now.toISOString()}::timestamptz)`,
        updatedAt: now,
      })
      .where(and(eq(schema.userJobs.jobId, jobId), isNull(schema.userJobs.deadAt)))
      .returning({ jobId: schema.userJobs.jobId });
    return updated.length > 0;
  }

  /**
   * Dead jobs the user has not yet dealt with — the review feed's query.
   * Cancellations are excluded at the source rather than by the caller:
   * `markCancelled` stamps `action_taken_at` on its way through, so a job
   * the user stopped on purpose can never come back asking about itself.
   */
  async findDeadUnacknowledged(
    userId: string,
    limit = 50,
    transaction?: DatabaseTransaction
  ): Promise<UserJob[]> {
    const db = this.getDb(transaction);
    const rows = await db
      .select()
      .from(schema.userJobs)
      .where(
        and(
          eq(schema.userJobs.userId, userId),
          isNotNull(schema.userJobs.deadAt),
          isNull(schema.userJobs.actionTakenAt),
          // Dismissing IS dealing with it — the feed must not ask again
          // (SC-292). Same reasoning as the `markCancelled` exclusion above.
          isNull(schema.userJobs.dismissedAt)
        )
      )
      // `created_at` breaks the tie: two jobs killed by the same worker
      // shutdown share a `dead_at` to the millisecond, and an unstable sort
      // makes the feed reshuffle itself between refetches.
      .orderBy(desc(schema.userJobs.deadAt), desc(schema.userJobs.createdAt))
      .limit(limit);
    return rows as UserJob[];
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
        // Terminal, and terminal for a reason the user already knows —
        // stamped here so a worker that fails moments later cannot relabel
        // a deliberate stop as "we tried three times" (SC-153).
        deadAt: new Date(),
        failureReason: 'cancelled',
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

  /**
   * Paginated list of jobs for a user; most recent first.
   *
   * **Without `result`, in SQL.** The list surfaces — the top-nav badge, the
   * jobs page rows — render none of it, and `jobs.listMine` has always
   * stripped the field before it reached the client. It stripped it in
   * TypeScript: `SELECT *` still detoasted up to 50 jsonb payloads per call
   * so the router could drop them, and that call is invalidated on **every
   * WS event during a recompute**. A wallet-import result measures 258 KB
   * (SC-145's 2,766-token wallet), so the discarded read was worth up to
   * ~13 MB out of Neon per invalidation.
   *
   * That read is the concrete cost SC-155 set out to remove, and removing it
   * needs a column list rather than a second datastore — see the ticket's
   * resolution. `findOneMine` and `findPendingReview` still select `result`
   * because both actually read it.
   */
  async findMine(
    userId: string,
    options: { state?: UserJobState; limit?: number; offset?: number },
    transaction?: DatabaseTransaction
  ): Promise<Omit<UserJob, 'result'>[]> {
    const db = this.getDb(transaction);
    // A dismissed row is hidden, not gone. The user asked for it out of their
    // list and that is honoured here; `findOneMine` still returns it (SC-292).
    const conditions = [eq(schema.userJobs.userId, userId), isNull(schema.userJobs.dismissedAt)];
    if (options.state) {
      conditions.push(eq(schema.userJobs.state, options.state));
    }
    const { result: _result, ...columns } = getTableColumns(schema.userJobs);
    const rows = await db
      .select(columns)
      .from(schema.userJobs)
      .where(and(...conditions))
      .orderBy(desc(schema.userJobs.createdAt))
      .limit(options.limit ?? 50)
      .offset(options.offset ?? 0);
    return rows as Omit<UserJob, 'result'>[];
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
   * Completed jobs of a reviewable kind that the user has not yet acted
   * on. Ordering matches the rest of the job surfaces: newest first.
   */
  async findPendingReview(
    userId: string,
    limit = 50,
    transaction?: DatabaseTransaction
  ): Promise<UserJob[]> {
    const db = this.getDb(transaction);
    const rows = await db
      .select()
      .from(schema.userJobs)
      .where(
        and(
          eq(schema.userJobs.userId, userId),
          eq(schema.userJobs.state, 'completed'),
          isNull(schema.userJobs.actionTakenAt),
          inArray(schema.userJobs.jobName, [...REVIEWABLE_JOB_NAMES])
        )
      )
      .orderBy(desc(schema.userJobs.createdAt))
      .limit(limit);
    return rows as UserJob[];
  }

  /**
   * One-shot stamp when the user consumes the follow-up action on a
   * job — either confirming the extracted holdings or discarding the
   * parse outright (SC-138). Idempotent: subsequent calls are no-ops
   * because of the `action_taken_at IS NULL` guard in the WHERE clause —
   * prevents double-imports even under rapid double-click, and means a
   * discard can never overwrite a completed import's outcome.
   *
   * Returns the stamp actually persisted (whether from this call or a
   * prior one), or `null` if the job isn't owned by this user.
   */
  async markActionTaken(
    userId: string,
    jobId: string,
    outcome: ReviewOutcome = 'imported',
    transaction?: DatabaseTransaction
  ): Promise<Date | null> {
    const db = this.getDb(transaction);
    const [updated] = await db
      .update(schema.userJobs)
      .set({ actionTakenAt: new Date(), reviewOutcome: outcome, updatedAt: new Date() })
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
        // A job that is running again is not dead. Leaving these set would
        // keep it in the review feed and on the "won't retry" chip while it
        // is visibly working (SC-153).
        deadAt: null,
        failureReason: null,
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
  /**
   * The user has cleared a failed job out of their list (SC-292).
   *
   * This was a hard DELETE, and that is how two `document-parse` failures on
   * 2026-08-11 came to have no record at all: four DLQ entries, two documents,
   * and not one matching row. Every `document-parse` row in the table is
   * `completed` — not because the job has never failed, but because the rows
   * that recorded failures were removed.
   *
   * Deleting made a dismissal indistinguishable from an upload that never
   * happened, and the user still holds the document. If they knew the parse
   * had failed they would upload it again; silence reads as "I already did
   * that one".
   *
   * So the row is kept and stamped. The user still gets the empty failed list
   * they asked for — `findMine` and `findDeadUnacknowledged` hide dismissed
   * rows — but `findOneMine` still returns it, so the record is retrievable
   * rather than destroyed.
   *
   * Still gated on `state = 'failed'` and on `dismissed_at IS NULL`: the
   * second makes it idempotent, and keeps a re-dismissal from overwriting the
   * original timestamp with a later one.
   */
  async dismissFailed(
    userId: string,
    jobId: string,
    transaction?: DatabaseTransaction
  ): Promise<boolean> {
    const db = this.getDb(transaction);
    const updated = await db
      .update(schema.userJobs)
      .set({ dismissedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.userJobs.jobId, jobId),
          eq(schema.userJobs.userId, userId),
          eq(schema.userJobs.state, 'failed'),
          isNull(schema.userJobs.dismissedAt)
        )
      )
      .returning({ jobId: schema.userJobs.jobId });
    return updated.length > 0;
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
