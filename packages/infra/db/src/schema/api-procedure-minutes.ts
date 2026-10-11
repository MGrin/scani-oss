import { integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

// Which tRPC procedures finished on which api machine in each minute
// (SC-1689), so a memory spike Fly's Prometheus shows at minute M on machine
// X can be attributed. SC-742's `api_procedure_calls` keeps one row per
// procedure and no history, and the Fly log buffer holds ~19 minutes.
//
//   select procedure, calls, max_duration_ms, max_loop_blocked_ms, max_rss_mb
//     from api_procedure_minutes
//    where machine = $X and minute = date_trunc('minute', $M::timestamptz)
//    order by max_rss_mb desc, max_duration_ms desc;
//
// `machine` is FLY_MACHINE_ID, the `instance` label on Fly's metrics.
//
// THE SHAPE IS THE PRIVACY GUARANTEE, as for SC-742: no column can hold a user
// id, an IP, a payload or a request id. Rows older than 14 days are pruned on
// the recorder's own flush, which outlasts Prometheus's ~11 days.
export const apiProcedureMinutes = pgTable(
  'api_procedure_minutes',
  {
    minute: timestamp('minute', { withTimezone: true }).notNull(),
    machine: text('machine').notNull(),
    procedure: text('procedure').notNull(),
    calls: integer('calls').notNull(),
    maxDurationMs: integer('max_duration_ms').notNull(),
    maxLoopBlockedMs: integer('max_loop_blocked_ms').notNull(),
    // Resident memory of the whole process when the call finished.
    maxRssMb: integer('max_rss_mb').notNull(),
  },
  (t) => [primaryKey({ columns: [t.minute, t.machine, t.procedure] })]
);
