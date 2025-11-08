import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

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
  baseCurrencyId: uuid('base_currency_id').references(() => tokens.id, {
    onDelete: 'restrict',
  }), // Reference to a fiat token

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Institutions table - Public, available to all users
export const institutions = pgTable(
  'institutions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    typeId: uuid('type_id')
      .notNull()
      .references(() => institutionTypes.id, { onDelete: 'restrict' }), // Reference to institution_types
    description: text('description'),
    website: text('website'),
    logoUrl: text('logo_url'),
    hasIntegration: boolean('has_integration').notNull().default(false), // Indicates if institution has API integration support
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for institution name globally
    uniqueInstitutionWebsite: unique().on(table.website),
    // Performance index for institution name lookups
    nameIdx: index('idx_institutions_name').on(table.name),
  })
);

// Tokens table (represents tradeable assets)
export const tokens = pgTable(
  'tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    symbol: text('symbol').notNull(),
    name: text('name').notNull(),
    typeId: uuid('type_id')
      .notNull()
      .references(() => tokenTypes.id, { onDelete: 'restrict' }), // Reference to token_types
    decimals: real('decimals').notNull().default(2),
    iconUrl: text('icon_url'),
    providerMetadata: text('provider_metadata').notNull().default('{}'), // JSON object for provider-specific data
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for symbol and type combination
    uniqueSymbolType: unique().on(table.symbol, table.typeId),
    // Performance index for symbol-based lookups in pricing service
    symbolIdx: index('idx_tokens_symbol').on(table.symbol),
    // Composite index for dashboard queries filtering by type
    typeIdIdx: index('idx_tokens_type_id').on(table.typeId),
  })
);

// Accounts table - User-specific
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    typeId: uuid('type_id')
      .notNull()
      .references(() => accountTypes.id, { onDelete: 'restrict' }), // Reference to account_types
    description: text('description'),
    metadata: jsonb('metadata').notNull().default('{}'), // Store wallet addresses and chain-specific data
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for account name per user per institution
    uniqueUserInstitutionAccountName: unique().on(table.userId, table.institutionId, table.name),
    // Performance indexes for account queries
    userIdIdx: index('idx_accounts_user_id').on(table.userId),
    institutionIdIdx: index('idx_accounts_institution_id').on(table.institutionId),
    // Composite index for dashboard queries
    userInstitutionIdx: index('idx_accounts_user_institution').on(
      table.userId,
      table.institutionId
    ),
  })
);

// Holdings table (token balances in accounts) - User-specific for consistency
export const holdings = pgTable(
  'holdings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict' }), // Prevent token deletion if holdings exist
    balance: text('balance').notNull(), // Store as string for Decimal.js precision
    source: text('source').notNull().default('manual'), // 'blockchain' or 'manual' - tracks origin of holding
    isHidden: boolean('is_hidden').notNull().default(false), // Hidden holdings are excluded from queries but updated by cron
    lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Performance indexes for frequently queried fields
    userIdIdx: index('idx_holdings_user_id').on(table.userId),
    accountIdIdx: index('idx_holdings_account_id').on(table.accountId),
    tokenIdIdx: index('idx_holdings_token_id').on(table.tokenId),
    // Composite indexes for dashboard queries
    userAccountTokenIdx: index('idx_holdings_user_account_token').on(
      table.userId,
      table.accountId,
      table.tokenId
    ),
    userTokenIdx: index('idx_holdings_user_token').on(table.userId, table.tokenId),
    // Index for filtering hidden holdings
    isHiddenIdx: index('idx_holdings_is_hidden').on(table.isHidden),
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
    price: text('price').notNull(), // Store as string for Decimal.js precision
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    source: text('source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for one price per token per base token per timestamp
    uniqueTokenPriceTimestamp: unique().on(table.tokenId, table.baseTokenId, table.timestamp),
    // Performance indexes for price lookups
    pricesLookupIdx: index('idx_token_prices_lookup').on(
      table.tokenId,
      table.baseTokenId,
      table.timestamp.desc()
    ),
    timestampIdx: index('idx_token_prices_timestamp').on(table.timestamp.desc()),
  })
);

// Telegram users table - Maps Telegram user IDs to Scani user accounts
export const telegramUsers = pgTable(
  'telegram_users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    telegramId: text('telegram_id').notNull().unique(), // Telegram user ID (numeric string)
    telegramUsername: text('telegram_username'), // Telegram username (optional)
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }), // Reference to Scani user
    isActive: boolean('is_active').notNull().default(true),
    lastInteractionAt: timestamp('last_interaction_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Index for fast lookups by telegram ID
    telegramIdIdx: index('idx_telegram_users_telegram_id').on(table.telegramId),
    // Index for user lookups
    userIdIdx: index('idx_telegram_users_user_id').on(table.userId),
  })
);

// User wallets table - Maps user wallets to multiple networks/institutions
export const userWallets = pgTable(
  'user_wallets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }), // Reference to Scani user
    walletAddress: text('wallet_address').notNull(), // Blockchain wallet address
    institutionIds: jsonb('institution_ids').notNull().default('[]'), // Array of institution IDs (networks) this wallet exists on
    label: text('label'), // Optional user-friendly label
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for wallet address per user
    uniqueUserWalletAddress: unique().on(table.userId, table.walletAddress),
    // Index for fast lookups by user ID
    userIdIdx: index('idx_user_wallets_user_id').on(table.userId),
    // Index for wallet address lookups
    walletAddressIdx: index('idx_user_wallets_wallet_address').on(table.walletAddress),
  })
);

// User integration credentials table - Stores encrypted OAuth tokens, API keys, etc.
export const userIntegrationCredentials = pgTable(
  'user_integration_credentials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }), // Reference to Scani user
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }), // Reference to institution
    encryptedCredentials: jsonb('encrypted_credentials').notNull(), // Encrypted OAuth tokens, API keys, etc.
    credentialsType: text('credentials_type').notNull(), // 'oauth', 'api_key', 'rpc', etc.
    isActive: boolean('is_active').notNull().default(true),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }), // For OAuth tokens with expiration
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for one credential set per user per institution
    uniqueUserInstitution: unique().on(table.userId, table.institutionId),
    // Index for fast lookups by user ID
    userIdIdx: index('idx_user_integration_credentials_user_id').on(table.userId),
    // Index for institution lookups
    institutionIdIdx: index('idx_user_integration_credentials_institution_id').on(
      table.institutionId
    ),
    // Composite index for user+institution queries
    userInstitutionIdx: index('idx_user_integration_credentials_user_institution').on(
      table.userId,
      table.institutionId
    ),
  })
);

// =============================================================================
// MAIN TABLES
// =============================================================================

// Relations
export const institutionTypesRelations = relations(institutionTypes, ({ many }) => ({
  institutions: many(institutions),
}));

export const accountTypesRelations = relations(accountTypes, ({ many }) => ({
  accounts: many(accounts),
}));

export const tokenTypesRelations = relations(tokenTypes, ({ many }) => ({
  tokens: many(tokens),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  accounts: many(accounts),
  holdings: many(holdings),
  userWallets: many(userWallets),
  userIntegrationCredentials: many(userIntegrationCredentials),
  baseCurrency: one(tokens, {
    fields: [users.baseCurrencyId],
    references: [tokens.id],
  }),
}));

export const institutionsRelations = relations(institutions, ({ one, many }) => ({
  type: one(institutionTypes, {
    fields: [institutions.typeId],
    references: [institutionTypes.id],
  }),
  accounts: many(accounts),
}));

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
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

export const holdingsRelations = relations(holdings, ({ one }) => ({
  user: one(users, {
    fields: [holdings.userId],
    references: [users.id],
  }),
  account: one(accounts, {
    fields: [holdings.accountId],
    references: [accounts.id],
  }),
  token: one(tokens, {
    fields: [holdings.tokenId],
    references: [tokens.id],
  }),
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

export const userWalletsRelations = relations(userWallets, ({ one }) => ({
  user: one(users, {
    fields: [userWallets.userId],
    references: [users.id],
  }),
}));

export const userIntegrationCredentialsRelations = relations(
  userIntegrationCredentials,
  ({ one }) => ({
    user: one(users, {
      fields: [userIntegrationCredentials.userId],
      references: [users.id],
    }),
    institution: one(institutions, {
      fields: [userIntegrationCredentials.institutionId],
      references: [institutions.id],
    }),
  })
);

// Export types for use in application
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type InstitutionType = typeof institutionTypes.$inferSelect;

export type AccountType = typeof accountTypes.$inferSelect;

export type TokenType = typeof tokenTypes.$inferSelect;

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

export type TelegramUser = typeof telegramUsers.$inferSelect;
export type NewTelegramUser = typeof telegramUsers.$inferInsert;

export type UserWallet = typeof userWallets.$inferSelect;
export type NewUserWallet = typeof userWallets.$inferInsert;

export type UserIntegrationCredentials = typeof userIntegrationCredentials.$inferSelect;
export type NewUserIntegrationCredentials = typeof userIntegrationCredentials.$inferInsert;
