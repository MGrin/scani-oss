import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users';

// Every change an AI agent made through `/mcp` (SC-1617), with the exact rows
// it touched, so the user can see it and take it back.
export const agentWrites = pgTable(
  'agent_writes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // A personal access token id, or `oauth:<clientId>`.
    actor: text('actor').notNull(),
    tool: text('tool').notNull(),
    input: jsonb('input').notNull(),
    result: jsonb('result'),
    status: text('status').notNull(),
    changeCount: integer('change_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    undoneBy: text('undone_by'),
    // The `Idempotency-Key` a REST write was sent with (SC-1648), claimed when
    // the row is inserted. Only a failure that changed nothing releases it.
    idempotencyKey: text('idempotency_key'),
  },
  (t) => ({
    statusCheck: check(
      'agent_writes_status_check',
      sql`${t.status} IN ('applied', 'failed', 'undone')`
    ),
    userCreatedIdx: index('agent_writes_user_created_idx').on(t.userId, t.createdAt),
    idempotencyKeyIdx: uniqueIndex('agent_writes_idempotency_key_idx')
      .on(t.userId, t.actor, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  })
);

// One row a write inserted (`before` null), deleted (`after` null) or changed,
// as the whole row image (`to_jsonb`). Undo writes `before` back.
export const agentWriteChanges = pgTable(
  'agent_write_changes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    writeId: uuid('write_id')
      .notNull()
      .references(() => agentWrites.id, { onDelete: 'cascade' }),
    tableName: text('table_name').notNull(),
    rowKey: text('row_key').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
  },
  (t) => ({
    writeIdx: index('agent_write_changes_write_idx').on(t.writeId),
  })
);

// The user's rows as they stood before a write in flight. Emptied when the
// write is recorded; only rows of a crashed write outlive it.
export const agentWriteSnapshots = pgTable(
  'agent_write_snapshots',
  {
    writeId: uuid('write_id')
      .notNull()
      .references(() => agentWrites.id, { onDelete: 'cascade' }),
    tableName: text('table_name').notNull(),
    rowKey: text('row_key').notNull(),
    image: jsonb('image').notNull(),
  },
  (t) => ({
    writeTableIdx: index('agent_write_snapshots_write_table_idx').on(
      t.writeId,
      t.tableName,
      t.rowKey
    ),
  })
);

// One agent write or undo at a time per user, across every api machine: the
// before/after diff would otherwise attribute one write's rows to the other.
export const agentWriteLocks = pgTable('agent_write_locks', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
});

// Every tool call an agent made through `/mcp` (SC-1618), refused and failed
// ones included, so the user can see what their agents asked for.
export const agentCalls = pgTable(
  'agent_calls',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // A personal access token id, or `oauth:<clientId>`.
    actor: text('actor').notNull(),
    tool: text('tool').notNull(),
    // The arguments as JSON, cut to a few hundred characters.
    argsSummary: text('args_summary').notNull(),
    outcome: text('outcome').notNull(),
    durationMs: integer('duration_ms').notNull(),
    agentWriteId: uuid('agent_write_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    outcomeCheck: check(
      'agent_calls_outcome_check',
      sql`${t.outcome} IN ('ok', 'error', 'refused')`
    ),
    userCreatedIdx: index('agent_calls_user_created_idx').on(t.userId, t.createdAt),
  })
);
