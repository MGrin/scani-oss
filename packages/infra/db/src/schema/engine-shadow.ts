import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { holdings } from './holdings';
import { tokens } from './tokens';
import { users } from './users';

export type EngineShadowRunKind = 'balance' | 'price';
export type EngineShadowRunStatus = 'complete' | 'failed';
export type EngineShadowRunScope = 'all' | 'user';

// One row per shadow run, with what it counted. Only the newest 30 runs of
// each kind and scope are kept, so an operator's one-user runs cannot prune
// the nightly history; the repository prunes the rest in the run's own
// transaction. `kind`, `status` and `scope` are CHECK-constrained in the
// migration, and `scope` has no default, so a run always says which it was.
export const engineShadowRuns = pgTable(
  'engine_shadow_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    kind: text('kind').$type<EngineShadowRunKind>().notNull(),
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    status: text('status').$type<EngineShadowRunStatus>().notNull(),
    scope: text('scope').$type<EngineShadowRunScope>().notNull(),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
    error: text('error'),
  },
  (table) => ({
    kindStartedIdx: index('idx_engine_shadow_runs_kind_started').on(
      table.kind,
      table.startedAt.desc()
    ),
  })
);

// One row per difference a run found; a match is only counted. A price
// difference belongs to no user, so `user_id` is nullable. The differences go
// with their run and with their user; the holding and tokens are references,
// and losing one clears it. A difference naming a holding names its user too
// (a CHECK in the migration). Each reference has a partial index, because the
// deletion manifest and every parent's cascade or SET NULL walk the table by it.
export const engineShadowDifferences = pgTable(
  'engine_shadow_differences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => engineShadowRuns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    holdingId: uuid('holding_id').references(() => holdings.id, { onDelete: 'set null' }),
    tokenId: uuid('token_id').references(() => tokens.id, { onDelete: 'set null' }),
    baseTokenId: uuid('base_token_id').references(() => tokens.id, { onDelete: 'set null' }),
    at: timestamp('at', { withTimezone: true }).notNull(),
    comparator: text('comparator').notNull(),
    category: text('category').notNull(),
    engineValue: text('engine_value'),
    legacyValue: text('legacy_value'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    runCategoryIdx: index('idx_engine_shadow_diffs_run_category').on(table.runId, table.category),
    userIdIdx: index('idx_engine_shadow_diffs_user_id')
      .on(table.userId)
      .where(sql`user_id IS NOT NULL`),
    holdingIdIdx: index('idx_engine_shadow_diffs_holding_id')
      .on(table.holdingId)
      .where(sql`holding_id IS NOT NULL`),
    tokenIdIdx: index('idx_engine_shadow_diffs_token_id')
      .on(table.tokenId)
      .where(sql`token_id IS NOT NULL`),
    baseTokenIdIdx: index('idx_engine_shadow_diffs_base_token_id')
      .on(table.baseTokenId)
      .where(sql`base_token_id IS NOT NULL`),
  })
);

export type EngineShadowRun = typeof engineShadowRuns.$inferSelect;
export type NewEngineShadowRun = typeof engineShadowRuns.$inferInsert;
export type EngineShadowDifference = typeof engineShadowDifferences.$inferSelect;
export type NewEngineShadowDifference = typeof engineShadowDifferences.$inferInsert;
