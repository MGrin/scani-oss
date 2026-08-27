import { bigint, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// One row per tRPC procedure the api has ever served, so the question
// "is anything still calling X" has an answer that outlives the Fly log
// buffer (100 lines, ~19 minutes — measured 2026-08-28). SC-727 had to
// close on judgement rather than evidence because nothing here recorded
// it; SC-742 is that gap.
//
// THE SHAPE IS THE PRIVACY GUARANTEE. Three columns, and none of them
// can hold a user id, an IP, a payload or a request id — not by policy
// but because there is nowhere to put one. A per-request event table
// would answer the same question and would need a retention policy, a
// PII review and a reason to be trusted; this needs none of the three.
// It is also why the row count is bounded by the number of procedures
// (163 today) rather than by traffic, so nothing ever has to prune it.
export const apiProcedureCalls = pgTable('api_procedure_calls', {
  procedure: text('procedure').primaryKey(),
  calls: bigint('calls', { mode: 'number' }).notNull().default(0),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ApiProcedureCall = typeof apiProcedureCalls.$inferSelect;
export type NewApiProcedureCall = typeof apiProcedureCalls.$inferInsert;
