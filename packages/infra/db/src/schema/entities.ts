import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { users } from './users';

/**
 * An ownership boundary over accounts — "my own money" and "the limited
 * company's money" as two sets of books with one owner (SC-463).
 *
 * **Why this is a scalar on `accounts` and not a group.** SC-463 asked first
 * whether a group could carry it. It cannot, and the reason is not that groups
 * are missing exclusivity — they REFUSE it. `GroupValuationService` counts a
 * holding fully in every group that claims it, and
 * `GroupValuationService.test.ts` pins that with a named test ("a holding
 * reached by two groups counts fully in both"), because the code it replaced
 * did the opposite and silently shorted the second group by a whole position
 * (SC-385). `AssetAllocationService` states it outright: the group cut is "the
 * one dimension whose buckets overlap".
 *
 * An ownership boundary is the opposite semantic. It has to be a partition, or
 * the two sets of books double-count where they overlap and the combined view
 * cannot be reconciled against them.
 *
 * `holdings.account_id` is `NOT NULL`, so a scalar here partitions every
 * holding for free — no junction table, no membership resolution, no veto, and
 * no second top-level dimension threaded through the domain. Per-entity is one
 * filter; combined is no filter.
 *
 * **There is deliberately no `is_active`.** Groups have one, and a group
 * deactivated under a holding drops it into `ungrouped` with no event —
 * tolerable for a label, and not for an ownership boundary, where it would
 * silently move assets between two sets of books. The only way out of an
 * entity is an explicit reassignment or deleting the entity, and deleting sets
 * its accounts back to unassigned rather than taking them with it.
 *
 * **This is not tax output and must not become it.** SC-90 is parked — see
 * `docs/technical/2026-08-14_why-no-tax-statement.md` — and separating the
 * books does not reopen it. Nothing here may acquire a tax framing: not a
 * column, not a heading, not a route.
 */
export const entities = pgTable(
  'entities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueUserEntityName: unique().on(table.userId, table.name),
    userIdIdx: index('idx_entities_user_id').on(table.userId),
  })
);

export const entitiesRelations = relations(entities, ({ one, many }) => ({
  user: one(users, {
    fields: [entities.userId],
    references: [users.id],
  }),
  accounts: many(accounts),
}));

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
