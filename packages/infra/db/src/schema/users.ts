import { relations } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
  // IANA zone reported by the browser, e.g. `Asia/Makassar`. NULL until the
  // app has been opened once since SC-226 — and the payment reminder SKIPS a
  // NULL rather than assuming UTC, because "17:00 UTC" is 01:00 in Singapore
  // and a reminder at the wrong hour is worse than none.
  timezone: text('timezone'),
  baseCurrencyId: uuid('base_currency_id').references(() => tokens.id, {
    onDelete: 'restrict',
  }), // Reference to a fiat token
  // Which rule the cost-basis walk matches disposals against for this account
  // (SC-462): `fifo` or `uk_section_104`. `text` with a CHECK rather than a pg
  // enum, and read through `parseCostBasisMethod` in `@scani/shared` — this
  // package cannot import the contract without depending on the frontend-safe
  // one, and the boundary parse is what a text column deserves anyway.
  //
  // Defaulted to `fifo` for every existing and new row on purpose. Every
  // realized figure ever shown was computed FIFO, so a default that changed
  // the rule would move all of them silently.
  costBasisMethod: text('cost_basis_method').notNull().default('fifo'),
  // First time this account got a file out of the product — an
  // "export everything" or a rendered statement (SC-450). Written once,
  // `WHERE first_export_at IS NULL`, and never updated after. It is the only
  // step of the activation funnel that no other table records: every other one
  // is derivable from rows the product already writes. NULL on the accounts
  // that predate the column means "unknown", not "never exported".
  firstExportAt: timestamp('first_export_at', { withTimezone: true }),
  // What every unsubscribe link authenticates on — a bearer credential, minted
  // per user, deliberately not `users.id` (which travels through API responses
  // and logs). ONE token for every stream (SC-459): the token names the
  // account, and which stream a link stops is the endpoint's business. A second
  // token column would be a second credential to rotate and a second way for a
  // reader to find out their click covered half their mail.
  emailUnsubscribeToken: uuid('email_unsubscribe_token').notNull().defaultRandom(),
  // Per-stream opt-outs, and they do not imply each other (SC-459). Muting a
  // weekly summary is not consent to be shown silently wrong figures when an
  // integration you connected stops syncing. NULL means subscribed.
  digestOptOutAt: timestamp('digest_opt_out_at', { withTimezone: true }),
  alertsOptOutAt: timestamp('alerts_opt_out_at', { withTimezone: true }),
  // The digest's retry guard: keeps a BullMQ retry of a half-finished run from
  // mailing the same people twice (SC-460). Alerts use `alert_deliveries`
  // instead — a per-account cooldown cannot express "not about Kraken again".
  digestLastSentAt: timestamp('digest_last_sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Better-Auth session table.
export const userSessions = pgTable(
  'user_sessions',
  {
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
  },
  (table) => ({
    // Better-Auth resolves sessions by user_id on every authenticated
    // request; without this index the lookup falls back to a sequential
    // scan as the table grows.
    userIdIdx: index('idx_user_sessions_user_id').on(table.userId),
  })
);

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
