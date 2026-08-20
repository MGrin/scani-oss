import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users';

// Enum created by migration 0047. Same pgEnum-binding rule as elsewhere
// — `eq(userJobs.state, 'active')` breaks on a plain `text` binding.
export const userJobStateEnum = pgEnum('user_job_state', [
  'queued',
  'active',
  'progress',
  'completed',
  'failed',
]);

// Durable mirror of user-initiated BullMQ jobs (see migration 0047).
// BullMQ evicts completed/failed jobs past retention
// (removeOnComplete/removeOnFail), so the "/jobs" UI reads from here for
// historical listings and falls back to here for `jobs.status` when
// Redis no longer has the job. The api's BullMqEnqueueService inserts
// a row before calling `queue.add`; the worker's UserJobLifecycleMirror
// updates state+progress+result on every lifecycle event.
export const userJobs = pgTable(
  'user_jobs',
  {
    jobId: text('job_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobName: text('job_name').notNull(),
    state: userJobStateEnum('state').notNull().default('queued'),
    progress: real('progress').notNull().default(0),
    result: jsonb('result'),
    error: text('error'),
    attemptsMade: integer('attempts_made').notNull().default(0),
    attemptsAllowed: integer('attempts_allowed').notNull().default(1),
    payloadSummary: jsonb('payload_summary').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // For jobs whose result requires a follow-up user action (review +
    // confirm of extracted holdings from a screenshot/PDF/CSV), this
    // stamps the one-shot moment the user acted on it. Re-visits after
    // this is set render the result read-only so the same extracted
    // holdings can't be imported twice. Null for informative-only jobs.
    actionTakenAt: timestamp('action_taken_at', { withTimezone: true }),
    // WHAT the user did, alongside WHEN. 'imported' | 'discarded'; null
    // while `actionTakenAt` is null. A discard clears the review queue
    // without writing holdings, and the job page has to be able to say
    // which of the two happened rather than assuming an import (SC-138).
    reviewOutcome: text('review_outcome'),
    // "This will not run again" — the one thing `state` could never say
    // (SC-153). `state='failed'` is written on every failed *attempt*, so
    // it covers a job mid-retry, a job that is dead, and a cancellation
    // alike. Null until something terminal happens; see migration 0034 for
    // why this is a column rather than a new `user_job_state` value.
    deadAt: timestamp('dead_at', { withTimezone: true }),
    // Which kind of terminal — the sentence the user needs differs per
    // reason. `userJobFailureReasonSchema` in @scani/shared is the
    // authority on the values; kept as `text` because it is a display
    // discriminator, not something a query filters on.
    failureReason: text('failure_reason'),
    /**
     * Set when the user cleared a failed job out of their list. The row is
     * KEPT — dismissal is a refusal, not an absence, and deleting it made
     * "I never uploaded that" and "I uploaded it and it failed" the same
     * observation (SC-292). Listing queries hide it; nothing destroys it.
     */
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  },
  (table) => ({
    userCreatedIdx: index('idx_user_jobs_user_created').on(table.userId, table.createdAt),
    userStateCreatedIdx: index('idx_user_jobs_user_state_created').on(
      table.userId,
      table.state,
      table.createdAt
    ),
  })
);

export type UserJob = typeof userJobs.$inferSelect;
export type NewUserJob = typeof userJobs.$inferInsert;
export type UserJobState = UserJob['state'];
