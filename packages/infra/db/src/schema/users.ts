import { relations } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { groups } from './groups';
import { holdings } from './holdings';
import { tokens } from './tokens';
import { userIntegrationCredentials } from './user-integration-credentials';
import { userWallets } from './user-wallets';
import { vaults } from './vaults';

// Main app user. Better-Auth canonical fields (id, email, emailVerified,
// name, image) plus our `avatar` (kept for back-compat) + `baseCurrencyId`
// for the user's preferred display fiat.
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(),
  emailVerified: boolean('email_verified').notNull().default(false),
  name: text('name').notNull(),
  avatar: text('avatar'),
  image: text('image'), // Better-Auth canonical field; we keep `avatar` too for back-compat
  baseCurrencyId: uuid('base_currency_id').references(() => tokens.id, {
    onDelete: 'restrict',
  }), // Reference to a fiat token
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Better-Auth session table.
export const userSessions = pgTable('user_sessions', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Better-Auth account table — auth provider linkage (NOT financial accounts;
// see ./accounts.ts for those).
export const userAccounts = pgTable('user_accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Better-Auth verification table — magic link / OTP / email verification
// nonce store.
export const userVerifications = pgTable('user_verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  accounts: many(accounts),
  holdings: many(holdings),
  userWallets: many(userWallets),
  userIntegrationCredentials: many(userIntegrationCredentials),
  groups: many(groups),
  vaults: many(vaults),
  baseCurrency: one(tokens, {
    fields: [users.baseCurrencyId],
    references: [tokens.id],
  }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
