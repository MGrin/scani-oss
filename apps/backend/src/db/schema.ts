import { relations } from 'drizzle-orm';
import { boolean, pgTable, real, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

// =============================================================================
// ENUM TABLES - Dynamic enum values stored in database
// =============================================================================

// Institution types table - dynamic enum values
export const institutionTypes = pgTable('institution_types', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(), // 'bank', 'broker', etc. - for programmatic use
  name: text('name').notNull(), // 'Bank', 'Broker', etc. - for display
  description: text('description'), // Optional description
  displayOrder: real('display_order').notNull().default(0), // For UI ordering
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Account types table - dynamic enum values
export const accountTypes = pgTable('account_types', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(), // 'checking', 'savings', etc.
  name: text('name').notNull(), // 'Checking Account', 'Savings Account', etc.
  description: text('description'),
  displayOrder: real('display_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Transaction types table - dynamic enum values
export const transactionTypes = pgTable('transaction_types', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(), // 'deposit', 'withdrawal', etc.
  name: text('name').notNull(), // 'Deposit', 'Withdrawal', etc.
  description: text('description'),
  displayOrder: real('display_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Token types table - dynamic enum values
export const tokenTypes = pgTable('token_types', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(), // 'fiat', 'crypto', etc.
  name: text('name').notNull(), // 'Fiat Currency', 'Cryptocurrency', etc.
  description: text('description'),
  displayOrder: real('display_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// =============================================================================
// MAIN TABLES
// =============================================================================

// Users table
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  avatar: text('avatar'),
  baseCurrency: text('base_currency').notNull().default('USD'), // User's preferred base currency

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Institutions table
export const institutions = pgTable(
  'institutions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    typeId: uuid('type_id')
      .notNull()
      .references(() => institutionTypes.id, { onDelete: 'restrict' }), // Reference to institution_types
    description: text('description'),
    website: text('website'),
    logoUrl: text('logo_url'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for institution name per user
    uniqueUserInstitutionName: unique().on(table.userId, table.name),
  })
);

// Tokens table (represents tradeable assets)
export const tokens = pgTable('tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  symbol: text('symbol').notNull(),
  name: text('name').notNull(),
  typeId: uuid('type_id')
    .notNull()
    .references(() => tokenTypes.id, { onDelete: 'restrict' }), // Reference to token_types
  decimals: real('decimals').notNull().default(2),
  iconUrl: text('icon_url'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Accounts table
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    typeId: uuid('type_id')
      .notNull()
      .references(() => accountTypes.id, { onDelete: 'restrict' }), // Reference to account_types
    description: text('description'),
    accountNumber: text('account_number'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for account name per institution
    uniqueInstitutionAccountName: unique().on(table.institutionId, table.name),
  })
);

// Holdings table (token balances in accounts)
export const holdings = pgTable(
  'holdings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict' }), // Prevent token deletion if holdings exist
    balance: real('balance').notNull(),
    averageCostBasis: real('average_cost_basis'),
    lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for one holding per token per account
    uniqueAccountTokenHolding: unique().on(table.accountId, table.tokenId),
  })
);

// Token prices table (historical prices)
export const tokenPrices = pgTable(
  'token_prices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'cascade' }),
    baseTokenId: uuid('base_token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict' }), // Prevent base token deletion
    price: real('price').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    source: text('source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for one price per token per base token per timestamp
    uniqueTokenPriceTimestamp: unique().on(table.tokenId, table.baseTokenId, table.timestamp),
  })
);

// Transactions table
export const transactions = pgTable('transactions', {
  id: uuid('id').defaultRandom().primaryKey(),
  holdingId: uuid('holding_id')
    .notNull()
    .references(() => holdings.id, { onDelete: 'cascade' }),
  typeId: uuid('type_id')
    .notNull()
    .references(() => transactionTypes.id, { onDelete: 'restrict' }), // Reference to transaction_types
  amount: real('amount').notNull(),
  price: real('price'), // Price per unit in base currency
  priceTokenId: uuid('price_token_id') // Currency of the price (defaults to user's base currency)
    .references(() => tokens.id, { onDelete: 'restrict' }),
  fee: real('fee').notNull().default(0),
  feeTokenId: uuid('fee_token_id') // Currency of the fee
    .references(() => tokens.id, { onDelete: 'restrict' }),
  description: text('description'),
  reference: text('reference'),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Relations
export const institutionTypesRelations = relations(institutionTypes, ({ many }) => ({
  institutions: many(institutions),
}));

export const accountTypesRelations = relations(accountTypes, ({ many }) => ({
  accounts: many(accounts),
}));

export const transactionTypesRelations = relations(transactionTypes, ({ many }) => ({
  transactions: many(transactions),
}));

export const tokenTypesRelations = relations(tokenTypes, ({ many }) => ({
  tokens: many(tokens),
}));

export const usersRelations = relations(users, ({ many }) => ({
  institutions: many(institutions),
}));

export const institutionsRelations = relations(institutions, ({ one, many }) => ({
  user: one(users, {
    fields: [institutions.userId],
    references: [users.id],
  }),
  type: one(institutionTypes, {
    fields: [institutions.typeId],
    references: [institutionTypes.id],
  }),
  accounts: many(accounts),
}));

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [accounts.institutionId],
    references: [institutions.id],
  }),
  type: one(accountTypes, {
    fields: [accounts.typeId],
    references: [accountTypes.id],
  }),
  holdings: many(holdings),
}));

export const tokensRelations = relations(tokens, ({ one, many }) => ({
  type: one(tokenTypes, {
    fields: [tokens.typeId],
    references: [tokenTypes.id],
  }),
  holdings: many(holdings),
  prices: many(tokenPrices),
  basePrices: many(tokenPrices, {
    relationName: 'basePrices',
  }),
}));

export const holdingsRelations = relations(holdings, ({ one, many }) => ({
  account: one(accounts, {
    fields: [holdings.accountId],
    references: [accounts.id],
  }),
  token: one(tokens, {
    fields: [holdings.tokenId],
    references: [tokens.id],
  }),
  transactions: many(transactions),
}));

export const tokenPricesRelations = relations(tokenPrices, ({ one }) => ({
  token: one(tokens, {
    fields: [tokenPrices.tokenId],
    references: [tokens.id],
  }),
  baseToken: one(tokens, {
    fields: [tokenPrices.baseTokenId],
    references: [tokens.id],
    relationName: 'basePrices',
  }),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  holding: one(holdings, {
    fields: [transactions.holdingId],
    references: [holdings.id],
  }),
  type: one(transactionTypes, {
    fields: [transactions.typeId],
    references: [transactionTypes.id],
  }),
}));

// Export types for use in application
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type InstitutionType = typeof institutionTypes.$inferSelect;
export type NewInstitutionType = typeof institutionTypes.$inferInsert;

export type AccountType = typeof accountTypes.$inferSelect;
export type NewAccountType = typeof accountTypes.$inferInsert;

export type TransactionType = typeof transactionTypes.$inferSelect;
export type NewTransactionType = typeof transactionTypes.$inferInsert;

export type TokenType = typeof tokenTypes.$inferSelect;
export type NewTokenType = typeof tokenTypes.$inferInsert;

export type Institution = typeof institutions.$inferSelect;
export type NewInstitution = typeof institutions.$inferInsert;

export type Token = typeof tokens.$inferSelect;
export type NewToken = typeof tokens.$inferInsert;

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

export type Holding = typeof holdings.$inferSelect;
export type NewHolding = typeof holdings.$inferInsert;

export type TokenPrice = typeof tokenPrices.$inferSelect;
export type NewTokenPrice = typeof tokenPrices.$inferInsert;

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
