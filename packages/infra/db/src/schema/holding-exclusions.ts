import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { institutions } from './institutions';
import { users } from './users';

// Tokens a user explicitly rejected for a wallet chain. The hourly
// `wallet-balances` cron auto-discovers newly-received tokens; without a
// record of past rejections it would re-create every token the user
// unchecked in the import-review step. A row here keys the rejection by
// the same `(institutionId, externalId)` pair the provider emits for a
// snapshot, so the cron can skip it.
export const holdingExclusions = pgTable(
  'holding_exclusions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    // The provider snapshot external id: `chain:contractAddress` for EVM
    // ERC-20s, `native` for the chain native asset, mint address for SPL.
    externalId: text('external_id').notNull(),
    reason: text('reason').notNull().default('user_unchecked'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueExclusion: unique('holding_exclusions_unique').on(
      table.userId,
      table.institutionId,
      table.externalId
    ),
    userInstitutionIdx: index('idx_holding_exclusions_user_institution').on(
      table.userId,
      table.institutionId
    ),
  })
);

export const holdingExclusionsRelations = relations(holdingExclusions, ({ one }) => ({
  user: one(users, {
    fields: [holdingExclusions.userId],
    references: [users.id],
  }),
  institution: one(institutions, {
    fields: [holdingExclusions.institutionId],
    references: [institutions.id],
  }),
}));

export type HoldingExclusion = typeof holdingExclusions.$inferSelect;
export type NewHoldingExclusion = typeof holdingExclusions.$inferInsert;
