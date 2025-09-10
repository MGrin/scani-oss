import { relations } from 'drizzle-orm';
import { integer, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

// Institution types table - dynamic enum values
export const institutionTypes = sqliteTable('institution_types', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(), // 'bank', 'broker', etc. - for programmatic use
  name: text('name').notNull(), // 'Bank', 'Broker', etc. - for display
  description: text('description'), // Optional description
  displayOrder: integer('display_order').notNull().default(0), // For UI ordering
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// Users table
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  avatar: text('avatar'),
  baseCurrency: text('base_currency').notNull().default('USD'), // User's preferred base currency

  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// Institutions table
export const institutions = sqliteTable(
  'institutions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    typeId: text('type_id')
      .notNull()
      .references(() => institutionTypes.id, { onDelete: 'restrict' }), // Reference to institution_types
    description: text('description'),
    website: text('website'),
    logoUrl: text('logo_url'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    // Unique constraint for institution name per user
    uniqueUserInstitutionName: unique().on(table.userId, table.name),
  })
);

// Tokens table (represents tradeable assets)
export const tokens = sqliteTable('tokens', {
  id: text('id').primaryKey(),
  symbol: text('symbol').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'fiat' | 'crypto' | 'stock' | 'etf' | 'bond' | 'commodity' | 'other'
  decimals: integer('decimals').notNull().default(2),
  iconUrl: text('icon_url'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// Accounts table
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    institutionId: text('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull(), // 'checking' | 'savings' | 'investment' | 'credit' | 'loan' | 'other'
    description: text('description'),
    accountNumber: text('account_number'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    // Unique constraint for account name per institution
    uniqueInstitutionAccountName: unique().on(table.institutionId, table.name),
  })
);

// Holdings table (token balances in accounts)
export const holdings = sqliteTable(
  'holdings',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenId: text('token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict' }), // Prevent token deletion if holdings exist
    balance: real('balance').notNull(),
    averageCostBasis: real('average_cost_basis'),
    lastUpdated: integer('last_updated', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    // Unique constraint for one holding per token per account
    uniqueAccountTokenHolding: unique().on(table.accountId, table.tokenId),
  })
);

// Token prices table (historical prices)
export const tokenPrices = sqliteTable(
  'token_prices',
  {
    id: text('id').primaryKey(),
    tokenId: text('token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'cascade' }),
    baseTokenId: text('base_token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict' }), // Prevent base token deletion
    price: real('price').notNull(),
    timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
    source: text('source'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    // Unique constraint for one price per token per base token per timestamp
    uniqueTokenPriceTimestamp: unique().on(table.tokenId, table.baseTokenId, table.timestamp),
  })
);

// Transactions table
export const transactions = sqliteTable('transactions', {
  id: text('id').primaryKey(),
  holdingId: text('holding_id')
    .notNull()
    .references(() => holdings.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // 'buy' | 'sell' | 'deposit' | 'withdrawal' | 'transfer' | 'dividend' | 'split' | 'other'
  amount: real('amount').notNull(),
  price: real('price'), // Price per unit in base currency
  priceTokenId: text('price_token_id') // Currency of the price (defaults to user's base currency)
    .references(() => tokens.id, { onDelete: 'restrict' }),
  fee: real('fee').notNull().default(0),
  feeTokenId: text('fee_token_id') // Currency of the fee
    .references(() => tokens.id, { onDelete: 'restrict' }),
  description: text('description'),
  reference: text('reference'),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// Relations
export const institutionTypesRelations = relations(institutionTypes, ({ many }) => ({
  institutions: many(institutions),
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
  holdings: many(holdings),
}));

export const tokensRelations = relations(tokens, ({ many }) => ({
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
}));

// Export types for use in application
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

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
