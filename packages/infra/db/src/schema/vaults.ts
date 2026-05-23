import { relations } from 'drizzle-orm';
import { boolean, index, pgTable, real, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { holdings } from './holdings';
import { tokens } from './tokens';
import { users } from './users';

// User-defined savings goals with target amounts. `currentAmount` is the
// pre-computed sum of attributed values across linked vault_holdings,
// kept denormalized so the dashboard renders without a recompute.
export const vaults = pgTable(
  'vaults',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    targetAmount: text('target_amount').notNull(), // Store as string for Decimal.js precision
    currencyId: uuid('currency_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict' }),
    currentAmount: text('current_amount').notNull().default('0'), // Pre-computed sum of attributed values
    color: text('color').notNull(), // Hex color code (e.g., '#3b82f6')
    iconName: text('icon_name'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueUserVaultName: unique().on(table.userId, table.name),
    userIdIdx: index('idx_vaults_user_id').on(table.userId),
    userActiveIdx: index('idx_vaults_user_active').on(table.userId, table.isActive),
  })
);

// Junction: links holdings to vaults with a percentage (1-100, fraction
// of holding attributed to this vault). One holding can split across
// multiple vaults; one vault can pull from multiple holdings.
export const vaultHoldings = pgTable(
  'vault_holdings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id, { onDelete: 'cascade' }),
    percentage: real('percentage').notNull(), // 1-100
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueVaultHolding: unique().on(table.vaultId, table.holdingId),
    vaultIdIdx: index('idx_vault_holdings_vault_id').on(table.vaultId),
    holdingIdIdx: index('idx_vault_holdings_holding_id').on(table.holdingId),
  })
);

export const vaultsRelations = relations(vaults, ({ one, many }) => ({
  user: one(users, {
    fields: [vaults.userId],
    references: [users.id],
  }),
  currency: one(tokens, {
    fields: [vaults.currencyId],
    references: [tokens.id],
  }),
  vaultHoldings: many(vaultHoldings),
}));

export const vaultHoldingsRelations = relations(vaultHoldings, ({ one }) => ({
  vault: one(vaults, {
    fields: [vaultHoldings.vaultId],
    references: [vaults.id],
  }),
  holding: one(holdings, {
    fields: [vaultHoldings.holdingId],
    references: [holdings.id],
  }),
}));

export type Vault = typeof vaults.$inferSelect;
export type NewVault = typeof vaults.$inferInsert;
export type VaultHolding = typeof vaultHoldings.$inferSelect;
export type NewVaultHolding = typeof vaultHoldings.$inferInsert;
