import { relations } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

// Maps user wallets to multiple networks/institutions. A single
// blockchain address may belong to several institution-typed networks
// (e.g. an EVM address active on Ethereum + Polygon + Arbitrum); the
// `institutionIds` jsonb array records all of them so wallet-import can
// fan out balance fetches.
export const userWallets = pgTable(
  'user_wallets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    walletAddress: text('wallet_address').notNull(),
    institutionIds: jsonb('institution_ids').notNull().default('[]'), // Array of institution IDs (networks) this wallet exists on
    label: text('label'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueUserWalletAddress: unique().on(table.userId, table.walletAddress),
    userIdIdx: index('idx_user_wallets_user_id').on(table.userId),
    walletAddressIdx: index('idx_user_wallets_wallet_address').on(table.walletAddress),
  })
);

export const userWalletsRelations = relations(userWallets, ({ one }) => ({
  user: one(users, {
    fields: [userWallets.userId],
    references: [users.id],
  }),
}));

export type UserWallet = typeof userWallets.$inferSelect;
export type NewUserWallet = typeof userWallets.$inferInsert;
