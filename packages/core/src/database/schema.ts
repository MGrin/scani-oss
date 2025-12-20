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

// Schedule types table - dynamic enum values
export const scheduleTypes = pgTable('schedule_types', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(), // 'income_allocation', 'subscription', 'payment', 'other'
  name: text('name').notNull(), // 'Income Allocation', 'Subscription', 'Payment', 'Other'
  description: text('description'),
  displayOrder: real('display_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Schedule step types table - dynamic enum values
export const scheduleStepTypes = pgTable('schedule_step_types', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(), // 'inflow', 'outflow', 'transfer', 'conversion'
  name: text('name').notNull(), // 'Inflow', 'Outflow', 'Transfer', 'Conversion'
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
    isScamProbability: real('is_scam_probability').notNull().default(0), // 0-1 probability of being a scam token (crypto only)
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
    isActive: boolean('is_active').notNull().default(true), // Inactive holdings are visible but excluded from total calculations
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
    // Index for filtering active holdings in calculations
    isActiveIdx: index('idx_holdings_is_active').on(table.isActive),
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

// Institution blockchain chain mappings table - Maps institutions to blockchain chain IDs
export const institutionBlockchainMappings = pgTable(
  'institution_blockchain_mappings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' })
      .unique(), // Each institution can only map to one chain
    chainId: text('chain_id').notNull(), // Blockchain chain ID (e.g., '1' for Ethereum, 'bitcoin', 'solana')
    chainType: text('chain_type').notNull(), // 'evm', 'bitcoin', 'solana', 'tron', 'ton'
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Index for fast lookups by institution ID
    institutionIdIdx: index('idx_institution_blockchain_mappings_institution_id').on(
      table.institutionId
    ),
    // Index for chain ID lookups
    chainIdIdx: index('idx_institution_blockchain_mappings_chain_id').on(table.chainId),
  })
);

// Institution Plaid mappings table - Maps institutions to Plaid institution IDs
export const institutionPlaidMappings = pgTable(
  'institution_plaid_mappings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' })
      .unique(), // Each institution can only map to one Plaid institution
    plaidInstitutionId: text('plaid_institution_id').notNull().unique(), // Plaid's institution ID (e.g., 'ins_3')
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Index for fast lookups by institution ID
    institutionIdIdx: index('idx_institution_plaid_mappings_institution_id').on(
      table.institutionId
    ),
    // Index for Plaid institution ID lookups
    plaidInstitutionIdIdx: index('idx_institution_plaid_mappings_plaid_institution_id').on(
      table.plaidInstitutionId
    ),
  })
);

// Plaid items table - Stores Plaid Item (connection) data per user
export const plaidItems = pgTable(
  'plaid_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),

    // Plaid-specific fields
    plaidItemId: text('plaid_item_id').notNull().unique(), // Plaid's item ID
    plaidAccessToken: text('plaid_access_token').notNull(), // Encrypted access token
    plaidInstitutionId: text('plaid_institution_id').notNull(), // Plaid's institution ID

    // Status tracking
    isActive: boolean('is_active').notNull().default(true),
    consentExpirationTime: timestamp('consent_expiration_time', { withTimezone: true }),
    error: jsonb('error'), // Store Plaid error if any

    // Sync tracking
    lastSuccessfulSync: timestamp('last_successful_sync', { withTimezone: true }),
    lastBalanceSync: timestamp('last_balance_sync', { withTimezone: true }),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for one item per user per institution
    uniqueUserInstitution: unique().on(table.userId, table.institutionId),
    // Index for fast lookups by user ID
    userIdIdx: index('idx_plaid_items_user_id').on(table.userId),
    // Index for institution lookups
    institutionIdIdx: index('idx_plaid_items_institution_id').on(table.institutionId),
    // Index for Plaid item ID lookups
    plaidItemIdIdx: index('idx_plaid_items_plaid_item_id').on(table.plaidItemId),
  })
);

// Plaid account mappings table - Maps Plaid accounts to Scani accounts
export const plaidAccountMappings = pgTable(
  'plaid_account_mappings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    plaidItemId: uuid('plaid_item_id')
      .notNull()
      .references(() => plaidItems.id, { onDelete: 'cascade' }),
    scaniAccountId: uuid('scani_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' })
      .unique(), // Each Scani account can only be mapped to one Plaid account
    plaidAccountId: text('plaid_account_id').notNull().unique(), // Plaid's account ID

    // Account metadata
    mask: text('mask'), // Last 4 digits of account number
    officialName: text('official_name'),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Index for fast lookups by plaid item ID
    plaidItemIdIdx: index('idx_plaid_account_mappings_plaid_item_id').on(table.plaidItemId),
    // Index for Scani account ID lookups
    scaniAccountIdIdx: index('idx_plaid_account_mappings_scani_account_id').on(
      table.scaniAccountId
    ),
    // Index for Plaid account ID lookups
    plaidAccountIdIdx: index('idx_plaid_account_mappings_plaid_account_id').on(
      table.plaidAccountId
    ),
  })
);

// Schedules table - User-specific patterns of monetary movements
export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    repetitiveCronPattern: text('repetitive_cron_pattern'), // Cron format for schedule repetition (optional when interval is set)
    interval: text('interval'), // Extended interval format: '2w' = every 2 weeks, '3M' = every 3 months, etc.
    intervalStartDate: timestamp('interval_start_date', { withTimezone: true }), // When to start counting intervals from
    lastExecuted: timestamp('last_executed', { withTimezone: true }), // Last time the schedule was executed
    typeId: uuid('type_id')
      .notNull()
      .references(() => scheduleTypes.id, { onDelete: 'restrict' }), // Reference to schedule_types
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Performance index for user queries
    userIdIdx: index('idx_schedules_user_id').on(table.userId),
    // Index for type-based filtering
    typeIdIdx: index('idx_schedules_type_id').on(table.typeId),
  })
);

// Schedule steps table - Steps within a schedule
export const scheduleSteps = pgTable(
  'schedule_steps',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    typeId: uuid('type_id')
      .notNull()
      .references(() => scheduleStepTypes.id, { onDelete: 'restrict' }), // Reference to schedule_step_types
    data: jsonb('data').notNull(), // Step-specific data (inflow, outflow, transfer, conversion)
    stepOrder: real('step_order').notNull().default(0), // Order of execution within schedule
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Performance index for schedule queries
    scheduleIdIdx: index('idx_schedule_steps_schedule_id').on(table.scheduleId),
    // Composite index for ordered step retrieval
    scheduleOrderIdx: index('idx_schedule_steps_schedule_order').on(
      table.scheduleId,
      table.stepOrder
    ),
  })
);

// Groups table - User-defined custom groups for organizing holdings
export const groups = pgTable(
  'groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(), // Hex color code (e.g., '#3b82f6')
    description: text('description'),
    displayOrder: real('display_order').notNull().default(0), // For custom ordering
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for group name per user
    uniqueUserGroupName: unique().on(table.userId, table.name),
    // Performance index for user queries
    userIdIdx: index('idx_groups_user_id').on(table.userId),
    // Index for ordering
    displayOrderIdx: index('idx_groups_display_order').on(table.userId, table.displayOrder),
  })
);

// Holding groups junction table - Many-to-many relationship between holdings and groups
export const holdingGroups = pgTable(
  'holding_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint to prevent duplicate assignments
    uniqueHoldingGroup: unique().on(table.holdingId, table.groupId),
    // Performance indexes for lookups
    holdingIdIdx: index('idx_holding_groups_holding_id').on(table.holdingId),
    groupIdIdx: index('idx_holding_groups_group_id').on(table.groupId),
  })
);

// Account groups junction table - Many-to-many relationship between accounts and groups
export const accountGroups = pgTable(
  'account_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint to prevent duplicate assignments
    uniqueAccountGroup: unique().on(table.accountId, table.groupId),
    // Performance indexes for lookups
    accountIdIdx: index('idx_account_groups_account_id').on(table.accountId),
    groupIdIdx: index('idx_account_groups_group_id').on(table.groupId),
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

export const scheduleTypesRelations = relations(scheduleTypes, ({ many }) => ({
  schedules: many(schedules),
}));

export const scheduleStepTypesRelations = relations(scheduleStepTypes, ({ many }) => ({
  scheduleSteps: many(scheduleSteps),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  accounts: many(accounts),
  holdings: many(holdings),
  userWallets: many(userWallets),
  userIntegrationCredentials: many(userIntegrationCredentials),
  schedules: many(schedules),
  groups: many(groups),
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
  blockchainMapping: one(institutionBlockchainMappings, {
    fields: [institutions.id],
    references: [institutionBlockchainMappings.institutionId],
  }),
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
  accountGroups: many(accountGroups),
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
  holdingGroups: many(holdingGroups),
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

export const institutionBlockchainMappingsRelations = relations(
  institutionBlockchainMappings,
  ({ one }) => ({
    institution: one(institutions, {
      fields: [institutionBlockchainMappings.institutionId],
      references: [institutions.id],
    }),
  })
);

export const schedulesRelations = relations(schedules, ({ one, many }) => ({
  user: one(users, {
    fields: [schedules.userId],
    references: [users.id],
  }),
  type: one(scheduleTypes, {
    fields: [schedules.typeId],
    references: [scheduleTypes.id],
  }),
  steps: many(scheduleSteps),
}));

export const scheduleStepsRelations = relations(scheduleSteps, ({ one }) => ({
  schedule: one(schedules, {
    fields: [scheduleSteps.scheduleId],
    references: [schedules.id],
  }),
  type: one(scheduleStepTypes, {
    fields: [scheduleSteps.typeId],
    references: [scheduleStepTypes.id],
  }),
}));

export const groupsRelations = relations(groups, ({ one, many }) => ({
  user: one(users, {
    fields: [groups.userId],
    references: [users.id],
  }),
  holdingGroups: many(holdingGroups),
  accountGroups: many(accountGroups),
}));

export const holdingGroupsRelations = relations(holdingGroups, ({ one }) => ({
  holding: one(holdings, {
    fields: [holdingGroups.holdingId],
    references: [holdings.id],
  }),
  group: one(groups, {
    fields: [holdingGroups.groupId],
    references: [groups.id],
  }),
}));

export const accountGroupsRelations = relations(accountGroups, ({ one }) => ({
  account: one(accounts, {
    fields: [accountGroups.accountId],
    references: [accounts.id],
  }),
  group: one(groups, {
    fields: [accountGroups.groupId],
    references: [groups.id],
  }),
}));

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

export type InstitutionBlockchainMapping = typeof institutionBlockchainMappings.$inferSelect;
export type NewInstitutionBlockchainMapping = typeof institutionBlockchainMappings.$inferInsert;

export type InstitutionPlaidMapping = typeof institutionPlaidMappings.$inferSelect;
export type NewInstitutionPlaidMapping = typeof institutionPlaidMappings.$inferInsert;

export type PlaidItem = typeof plaidItems.$inferSelect;
export type NewPlaidItem = typeof plaidItems.$inferInsert;

export type PlaidAccountMapping = typeof plaidAccountMappings.$inferSelect;
export type NewPlaidAccountMapping = typeof plaidAccountMappings.$inferInsert;

export type ScheduleType = typeof scheduleTypes.$inferSelect;

export type ScheduleStepType = typeof scheduleStepTypes.$inferSelect;

export type Schedule = typeof schedules.$inferSelect;
export type NewSchedule = typeof schedules.$inferInsert;

export type ScheduleStep = typeof scheduleSteps.$inferSelect;
export type NewScheduleStep = typeof scheduleSteps.$inferInsert;

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;

export type HoldingGroup = typeof holdingGroups.$inferSelect;
export type NewHoldingGroup = typeof holdingGroups.$inferInsert;

export type AccountGroup = typeof accountGroups.$inferSelect;
export type NewAccountGroup = typeof accountGroups.$inferInsert;
