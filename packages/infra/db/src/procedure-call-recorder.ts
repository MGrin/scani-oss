/**
 * Buffered counter for "which tRPC procedures does anything still call".
 *
 * Every procedure invocation bumps an in-memory tally; a timer flushes the
 * tallies into `api_procedure_calls` as one upsert per distinct procedure.
 * The request path never awaits a write.
 *
 * WHY A COUNTER AND NOT A REQUEST LOG (SC-742). The question this exists to
 * answer is a NEGATIVE — "has anything called X since May" — and a negative
 * needs a COMPLETE record, not a sample. That rules out the two things that
 * already existed: the Fly log buffer holds 100 lines (~19 minutes, measured
 * 2026-08-28), and Sentry tracing runs at `tracesSampleRate: 0.1` and then
 * dynamically samples the searchable store again on top of that. Both answer
 * "X IS called" cheaply and neither can answer "X is NOT called" at all —
 * zero traces for a procedure called once a month is the expected reading
 * whether or not anyone called it.
 *
 * THIS IS THE RUNTIME HALF OF A TWO-HALF QUESTION. `scripts/api-procedure-callers.ts`
 * answers the STATIC half — who calls each procedure in this tree — and its own
 * docblock is explicit that "no caller in this tree" is not a deletion list,
 * because a procedure with no in-repo caller is either dead surface or an
 * external contract the tree cannot see, and those want opposite treatment.
 * This table is what separates them: an in-repo census plus a `last_seen_at`
 * that has stayed empty across a real retention window is evidence; either one
 * alone is a judgement. Neither is a deletion list by itself.
 *
 * THE TIMER IS ARMED ON RECORD, NEVER ON A SCHEDULE. This is load-bearing
 * rather than tidy: Neon scales to zero, and the repo deliberately aligns the
 * quarter-hour probes so it can. A periodic flusher would hold the database
 * awake for the life of the process and turn an idle deployment into a
 * billed one. An api with no traffic writes nothing here and lets Neon sleep.
 *
 * WHY POSTGRES AND NOT REDIS. Redis is the obvious home for a counter, and it
 * is the wrong one here for a reason that is about the CONSEQUENCE OF BEING
 * WRONG rather than about any property of the store. What this produces is a
 * NEVER-FIRED list, and a never-fired list licenses deletions. A counter that
 * quietly loses a row turns "called twice in June" into "never called", and
 * the next reader deletes a procedure something outside this repo still calls.
 * Redis evicts under `maxmemory` and an eviction leaves nothing behind, so
 * that corrupted negative is INDISTINGUISHABLE FROM THE TRUE ONE it replaced —
 * no error, no gap, nothing for a reader to notice. The damage surfaces later
 * as a 404 in somebody else's integration, with no path back to the cause.
 *
 * A row in the Postgres the api already depends on can only vanish if the
 * database loses it, which is a failure this deployment must already survive
 * for every other table. The write cost is one buffered upsert a minute per
 * machine against a connection that is already open, so choosing the durable
 * store here buys the artefact's entire meaning for approximately nothing.
 *
 * THE SAME FLUSH WRITES A PER-MINUTE ROLLUP (SC-1689). A memory spike on one
 * api machine could not be traced to a route: the counter above has no
 * history. Each finished call also lands in `api_procedure_minutes`, keyed by
 * the minute it finished in and the machine, with the worst duration, loop
 * block and process RSS of that minute. It rides this flush, so it adds no
 * write per request and no wake of its own.
 */

import { hostname } from 'node:os';
import { lt, sql } from 'drizzle-orm';
import { db } from './connection';
import { apiProcedureCalls } from './schema/api-procedure-calls';
import { apiProcedureMinutes } from './schema/api-procedure-minutes';

export interface ProcedureCallTally {
  procedure: string;
  calls: number;
  lastSeenAt: Date;
}

/** One procedure's finished calls in one minute on one machine (SC-1689). */
export interface ProcedureMinute {
  minute: Date;
  machine: string;
  procedure: string;
  calls: number;
  maxDurationMs: number;
  maxLoopBlockedMs: number;
  maxRssMb: number;
}

/** Persists one flush. Injected so the buffering logic is testable without a database. */
export type ProcedureCallWriter = (tallies: ProcedureCallTally[]) => Promise<void>;

/** Persists one flush of minute rows. Injected for the same reason. */
export type ProcedureMinuteWriter = (minutes: ProcedureMinute[]) => Promise<void>;

export interface ProcedureCallRecorder {
  /** Count one invocation. Never throws, never awaits. */
  record(procedure: string): void;
  /** Roll one finished call into its minute's row. Never throws, never awaits. */
  complete(procedure: string, sample: { durationMs: number; loopBlockedMs: number }): void;
  /** Drain the buffer. Safe to call when empty; used by the shutdown path. */
  flush(): Promise<void>;
  /**
   * Procedure names currently buffered. Returns the NAMES rather than a count
   * so a caller can assert which procedure was recorded: a count moving from
   * 0 to 1 is equally satisfied by a recorder that files everything under a
   * constant, which is the defect worth catching here.
   */
  pending(): string[];
  /** Procedure names with a buffered minute row, as names for the same reason. */
  pendingMinutes(): string[];
}

// yagni: counts are approximate across restarts — anything buffered when a
// machine goes away is lost. The question is presence and recency, not an
// exact total, so a lost partial minute changes no answer. Revisit only if
// someone needs these numbers to reconcile against billing.
const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
const MINUTE_MS = 60_000;

export function createProcedureCallRecorder(
  write: ProcedureCallWriter,
  options: {
    flushIntervalMs?: number;
    now?: () => Date;
    writeMinutes?: ProcedureMinuteWriter;
    machine?: string;
    readRssBytes?: () => number;
  } = {}
): ProcedureCallRecorder {
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const writeMinutes = options.writeMinutes ?? (async () => {});
  const machine = options.machine ?? process.env.FLY_MACHINE_ID ?? hostname();
  const readRssBytes = options.readRssBytes ?? (() => process.memoryUsage.rss());
  const buffer = new Map<string, number>();
  const minutes = new Map<string, ProcedureMinute>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function arm(): void {
    if (timer) return;
    timer = setTimeout(() => void flush(), flushIntervalMs);
    // Do not hold the process open for a pending tally; the shutdown
    // path calls flush() explicitly.
    timer.unref?.();
  }

  async function settle(count: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      // A dropped tally costs one flush of counts and nothing else. Failing
      // the caller — a shutdown handler, or the timer's own tick — would
      // convert a bookkeeping problem into an outage.
      console.warn(
        `[procedure-calls] failed to flush ${count}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.size > 0) {
      const at = now();
      const tallies: ProcedureCallTally[] = [...buffer.entries()].map(([procedure, calls]) => ({
        procedure,
        calls,
        lastSeenAt: at,
      }));
      buffer.clear();
      await settle(`${tallies.length} tally(ies)`, () => write(tallies));
    }
    if (minutes.size > 0) {
      const rows = [...minutes.values()];
      minutes.clear();
      await settle(`${rows.length} minute row(s)`, () => writeMinutes(rows));
    }
  }

  return {
    record(procedure: string): void {
      buffer.set(procedure, (buffer.get(procedure) ?? 0) + 1);
      arm();
    },
    complete(procedure, { durationMs, loopBlockedMs }): void {
      const at = now().getTime();
      const minute = new Date(at - (at % MINUTE_MS));
      const key = `${minute.toISOString()} ${procedure}`;
      const duration = Math.round(durationMs);
      const blocked = Math.round(loopBlockedMs);
      const rssMb = Math.round(readRssBytes() / 2 ** 20);
      const row = minutes.get(key);
      if (row) {
        row.calls += 1;
        row.maxDurationMs = Math.max(row.maxDurationMs, duration);
        row.maxLoopBlockedMs = Math.max(row.maxLoopBlockedMs, blocked);
        row.maxRssMb = Math.max(row.maxRssMb, rssMb);
      } else {
        minutes.set(key, {
          minute,
          machine,
          procedure,
          calls: 1,
          maxDurationMs: duration,
          maxLoopBlockedMs: blocked,
          maxRssMb: rssMb,
        });
      }
      // A call that outlived the flush its record() armed finishes into an
      // empty buffer, so it arms one of its own.
      arm();
    },
    flush,
    pending: () => [...buffer.keys()],
    pendingMinutes: () => [...new Set([...minutes.values()].map((row) => row.procedure))],
  };
}

/**
 * The upsert, built but not executed — so a test can read the SQL this
 * actually generates instead of reading the comment below and agreeing with
 * it. A comment cannot fail; rendered SQL can.
 */
export function buildProcedureCallUpsert(tallies: ProcedureCallTally[]) {
  return db
    .insert(apiProcedureCalls)
    .values(
      tallies.map((t) => ({
        procedure: t.procedure,
        calls: t.calls,
        // Both timestamps are this flush's. On a first insert they are equal;
        // afterwards only `lastSeenAt` moves.
        firstSeenAt: t.lastSeenAt,
        lastSeenAt: t.lastSeenAt,
      }))
    )
    .onConflictDoUpdate({
      target: apiProcedureCalls.procedure,
      set: {
        // `excluded` is this flush's row. Adding rather than replacing is what
        // makes the total cumulative across every machine and every deploy.
        calls: sql`${apiProcedureCalls.calls} + excluded.calls`,
        lastSeenAt: sql`excluded.last_seen_at`,
        // firstSeenAt IS DELIBERATELY ABSENT FROM THIS SET. DO NOT ADD IT.
        //
        // An upsert that does not set one of its own columns reads as an
        // oversight, and adding it looks like a one-line completion. It is
        // not: `first_seen_at` DATES the record, and advancing it silently
        // shortens every observation window anybody has already quoted —
        // with no error, no failing row, and a diff nobody would question.
        // That is this column's own failure mode arriving through the
        // column itself.
        //
        // Pinned by `the upsert never advances first_seen_at` in
        // `tests/procedure-call-recorder.test.ts`, which reads the rendered
        // SQL rather than this comment.
      },
    });
}

const writeProcedureCallsToDb: ProcedureCallWriter = async (tallies) => {
  await buildProcedureCallUpsert(tallies);
};

// Outlasts Fly Prometheus's ~11 days of memory history, the other half of the join.
const PROCEDURE_MINUTES_RETAIN_MS = 14 * 86_400_000;

/**
 * Two flushes into one minute — a timer that fired mid-minute, or a restart
 * within it — add their calls and keep the worst figures.
 * Built but not executed, so a test can read the SQL.
 */
export function buildProcedureMinuteUpsert(rows: ProcedureMinute[]) {
  return db
    .insert(apiProcedureMinutes)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        apiProcedureMinutes.minute,
        apiProcedureMinutes.machine,
        apiProcedureMinutes.procedure,
      ],
      set: {
        calls: sql`${apiProcedureMinutes.calls} + excluded.calls`,
        maxDurationMs: sql`greatest(${apiProcedureMinutes.maxDurationMs}, excluded.max_duration_ms)`,
        maxLoopBlockedMs: sql`greatest(${apiProcedureMinutes.maxLoopBlockedMs}, excluded.max_loop_blocked_ms)`,
        maxRssMb: sql`greatest(${apiProcedureMinutes.maxRssMb}, excluded.max_rss_mb)`,
      },
    });
}

const writeProcedureMinutesToDb: ProcedureMinuteWriter = async (rows) => {
  await buildProcedureMinuteUpsert(rows);
  // Retention rides the flush's wake, so it adds none: an idle api prunes
  // nothing and lets Neon sleep, and no worker job has to exist for it.
  await db
    .delete(apiProcedureMinutes)
    .where(lt(apiProcedureMinutes.minute, new Date(Date.now() - PROCEDURE_MINUTES_RETAIN_MS)));
};

/**
 * Process-wide recorder used by the api's tRPC middleware. A module-level
 * singleton because the buffer must be shared by every request in the
 * process — one buffer per request would defeat the batching entirely.
 */
export const procedureCallRecorder = createProcedureCallRecorder(writeProcedureCallsToDb, {
  writeMinutes: writeProcedureMinutesToDb,
});
