import { relations, sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
export const users = pgTable(
  'users',
  {
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
    // The user's correction to the MEASURED monthly drain (SC-661). An override
    // is not a declaration, and the difference is that an override has something
    // to disagree with — the runway is still computed from observed perimeter
    // outflows, and this replaces that figure only where the user has said it is
    // wrong. Named for what it corrects so nobody reads it as a self-reported
    // spend: a declared-figure headline was built and rejected, because people
    // asked what they spend give typical recurring spend and omit exceptional
    // items (~2x overstatement on the one production book, in the flattering
    // direction).
    //
    // All three move together, enforced by `users_observed_burn_override_complete`:
    // an amount with no currency cannot be converted, and an override with no date
    // is the one thing here that goes stale while standing still.
    observedBurnOverride: text('observed_burn_override'),
    observedBurnOverrideCurrencyId: uuid('observed_burn_override_currency_id').references(
      () => tokens.id,
      { onDelete: 'restrict' }
    ),
    observedBurnOverrideAt: timestamp('observed_burn_override_at', { withTimezone: true }),
    // The other thing the user may do to the drain: AGREE with it (SC-661).
    //
    // `observedBurnConfirmedValue` is not the amount he confirmed kept for the
    // record — it is **the amount that must still match for the confirmation to
    // mean anything**. The drain is recomputed every time the window moves, so a
    // confirmation of 8.1 read against a bare timestamp still says he agreed when
    // the figure is 11.4. That is a claim about the present made out of a record
    // of the past, and it is the same defect SC-673 is fixing one layer up:
    // `answerSourceOf` infers WHO answered from a timestamp.
    //
    // An override stores no such pairing because it REPLACES the figure rather
    // than agreeing with it. Only agreement can be invalidated by the thing it
    // agreed with moving.
    //
    // `users_observed_burn_one_answer` forbids holding both: agreeing and
    // replacing are contradictory answers to one question, and a row carrying
    // both is this ticket's own defect moved from two screens into one row.
    //
    // The stronger half is the SEQUENCE. The real path is: override, the
    // measurement later moves to something he agrees with, confirm THAT — and
    // every step requires clearing the other pair. A write that forgets leaves a
    // silent second answer, which nothing reads as an error and nobody goes
    // looking for. The constraint makes forgetting a refusal at the moment it
    // happens, which is the only moment it is visible.
    observedBurnConfirmedValue: text('observed_burn_confirmed_value'),
    observedBurnConfirmedCurrencyId: uuid('observed_burn_confirmed_currency_id').references(
      () => tokens.id,
      { onDelete: 'restrict' }
    ),
    observedBurnConfirmedAt: timestamp('observed_burn_confirmed_at', { withTimezone: true }),
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
  },
  (table) => ({
    // SC-934. One account per mailbox, case-insensitively — the identity that
    // billing resolves entitlement against, so a second account on the same
    // address is a second claim on the same subscription.
    //
    // On `lower(email)` rather than `.unique()` on the column, because `A@b.com`
    // and `a@b.com` are one mailbox everywhere except a plain UNIQUE. Better-Auth
    // does lowercase on write at every entry point (`internalAdapter.createUser`
    // and `updateUser` normalise the value, `findUserByEmail` normalises the
    // needle) — but that makes canonical storage a property BORROWED from a
    // library this schema does not own, and no test here would go red if a
    // version bump dropped it. This states the same invariant where it cannot
    // silently regress, and it refuses everything `UNIQUE(email)` would refuse
    // as well as the case variants.
    emailLowerUq: uniqueIndex('users_email_lower_unique').on(sql`lower(${table.email})`),
    // SC-938. Declared here, created by migration 20260819141744 (as
    // `idx_users_digest_unsubscribe_token`) and renamed by 20260819145111 — so
    // this adds no migration and changes no database. Unique because the token
    // is the whole of what `/e/u/:token` authenticates on, and indexed because
    // a lookup by it is that endpoint's only query.
    //
    // It was absent from this file from the day it was created until SC-938,
    // and nothing went red: `schema-drift.test.ts` compares COLUMNS — its
    // `expectedSchema()` yields `[table, columns]` and its real-database arm
    // queries `information_schema.columns` — so an index in one place and not
    // the other is outside what that guard can see by construction, the same
    // shape as the `SELECT 1` health check its own docstring is about.
    emailUnsubscribeTokenUq: uniqueIndex('idx_users_email_unsubscribe_token').on(
      table.emailUnsubscribeToken
    ),
  })
);

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

/**
 * Every time this account's cost-basis method changed (SC-957).
 *
 * The method decides which lots a disposal is matched against, so changing it
 * moves every realized figure the account has already been shown. It stays
 * freely changeable — mgrin weighed locking it and declined, because FIFO
 * against section 104 is the decision a new user is least equipped to make —
 * and this is what makes a moved figure explicable instead of unrecoverable.
 *
 * Append-only, one row per transition, and a row cannot record a non-change:
 * `previous_method <> new_method` is a CHECK, so every row here moved somebody's
 * numbers. A single `changed_at` column on `users` was the cheaper shape and
 * cannot answer the actual question — an account that went fifo -> s104 -> fifo
 * has figures from three eras and one timestamp separates none of them.
 */
export const userCostBasisMethodChanges = pgTable(
  'user_cost_basis_method_changes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Both carry the same CHECK as `users.cost_basis_method` and are read
    // through `parseCostBasisMethod` in `@scani/shared`, for the reason given
    // on that column: this package cannot import the contract.
    previousMethod: text('previous_method').notNull(),
    newMethod: text('new_method').notNull(),
    // Which write path made the change. CHECK-constrained to one value, because
    // there is one writer — `UserService.updateUser`, reached only by
    // `users.updateCurrent`. A second one costs a migration, which is the loud
    // step; a nullable actor column that is always the same user is not.
    source: text('source').notNull(),
    // `clock_timestamp()` rather than `defaultNow()`: `now()` is
    // transaction_timestamp() and does not advance within a transaction, so two
    // changes committed together would tie and the newest-first ordering could
    // not say which era followed which.
    changedAt: timestamp('changed_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => ({
    // The only query: this account's methods, newest first. "Which method was
    // that figure computed under" is answered by walking back from now.
    userChangedAtIdx: index('idx_user_cost_basis_method_changes_user_changed_at').on(
      table.userId,
      table.changedAt
    ),
  })
);

export const usersRelations = relations(users, ({ one, many }) => ({
  accounts: many(accounts),
  holdings: many(holdings),
  userWallets: many(userWallets),
  userIntegrationCredentials: many(userIntegrationCredentials),
  costBasisMethodChanges: many(userCostBasisMethodChanges),
  groups: many(groups),
  vaults: many(vaults),
  baseCurrency: one(tokens, {
    fields: [users.baseCurrencyId],
    references: [tokens.id],
  }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type UserCostBasisMethodChange = typeof userCostBasisMethodChanges.$inferSelect;
export type NewUserCostBasisMethodChange = typeof userCostBasisMethodChanges.$inferInsert;
