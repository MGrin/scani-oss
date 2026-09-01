import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

// One condition an operator alarm is currently OPEN on (SC-870).
//
// A row is the answer to "have we already been told about this?", and its
// ABSENCE is the answer to "has it cleared?" — the same shape `alert_deliveries`
// gives the user-facing half of the same signal, which is where this pattern is
// borrowed from. What was missing is that the OPERATOR-facing half never had
// it: `stale-sync-probe` re-escalated on every hourly probe for as long as a
// condition held, so one unresolved integration could outnumber every other
// signal the service produced and make a once-a-day failure unreadable.
//
// `openedAt` is written once, at the transition in, and is deliberately not
// touched by a re-statement: it is how long the condition has been true.
// `lastFiredAt` moves on every escalation, so the re-notify window restarts
// from the last thing anybody was told rather than from the first.
//
// Postgres rather than Redis on purpose. Redis here is `redis-server` embedded
// in the worker's own machine, so its lifetime is CORRELATED with the worker's
// — and "the worker restarted" is precisely the event that must not re-fire a
// week-old alarm. Losing this table is survivable in the safe direction: each
// open condition is re-stated once and then re-arms.
export const operatorAlarms = pgTable(
  'operator_alarms',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // The named alarm, e.g. `stale-sync`. Text, not an enum: an alarm is added
    // by a deploy, and an enum would make that a migration.
    alarm: text('alarm').notNull(),
    // What, within that alarm, this row is about — a credential id here.
    // Opaque to everything but the alarm that minted it.
    alarmKey: text('alarm_key').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex('idx_operator_alarms_identity').on(table.alarm, table.alarmKey)]
);

export type OperatorAlarm = typeof operatorAlarms.$inferSelect;
export type NewOperatorAlarm = typeof operatorAlarms.$inferInsert;
