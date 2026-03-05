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
  email: text('email'), // Nullable for agentic users
  name: text('name').notNull(),
  avatar: text('avatar'),
  baseCurrencyId: uuid('base_currency_id').references(() => tokens.id, {
    onDelete: 'restrict',
  }), // Reference to a fiat token
  // User type: 'regular' for normal users, 'agentic' for AI agent users
  userType: text('user_type').notNull().default('regular'),
  // For agentic users that get linked to a regular account later
  // Self-reference handled as plain UUID (foreign key added via SQL migration)
  linkedToUserId: uuid('linked_to_user_id'),

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

// User portfolio events table - Pre-computed events for fast history queries
// Events are created at write-time when holdings change or prices update
export const userPortfolioEvents = pgTable(
  'user_portfolio_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // User and timestamp
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),

    // Event type: 'holding_create', 'holding_update', 'holding_delete', 'price_update'
    eventType: text('event_type').notNull(),

    // Source of the event (blockchain, manual, plaid, exchange, etc.)
    source: text('source'),

    // Entity references for filtering
    holdingId: uuid('holding_id').references(() => holdings.id, {
      onDelete: 'cascade',
    }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    institutionId: uuid('institution_id').references(() => institutions.id, {
      onDelete: 'set null',
    }),

    // Token info (denormalized to avoid JOINs at query time)
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'cascade' }),
    tokenSymbol: text('token_symbol').notNull(),
    tokenName: text('token_name').notNull(),

    // Values at event time (snapshot)
    balance: text('balance').notNull(),
    price: text('price').notNull(),
    value: text('value').notNull(), // Pre-computed: balance * price

    // Base currency for the price
    baseCurrencyId: uuid('base_currency_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict' }),

    // Metadata
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Primary query pattern: events by user, sorted by time
    userTimestampIdx: index('idx_user_portfolio_events_user_timestamp').on(
      table.userId,
      table.timestamp.desc()
    ),
    // Filter by holding
    holdingIdx: index('idx_user_portfolio_events_holding').on(
      table.userId,
      table.holdingId,
      table.timestamp.desc()
    ),
    // Filter by account
    accountIdx: index('idx_user_portfolio_events_account').on(
      table.userId,
      table.accountId,
      table.timestamp.desc()
    ),
    // Filter by institution
    institutionIdx: index('idx_user_portfolio_events_institution').on(
      table.userId,
      table.institutionId,
      table.timestamp.desc()
    ),
    // Filter by event type
    eventTypeIdx: index('idx_user_portfolio_events_type').on(
      table.userId,
      table.eventType,
      table.timestamp.desc()
    ),
    // Filter by token
    tokenIdx: index('idx_user_portfolio_events_token').on(
      table.userId,
      table.tokenId,
      table.timestamp.desc()
    ),
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

// Groups table - User-defined custom groups for organizing holdings
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

// API Keys table - Stores hashed API keys for MCP server authentication
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // User-friendly name for the key
    keyHash: text('key_hash').notNull(), // Bcrypt hash of the API key
    keyPrefix: text('key_prefix').notNull(), // First 8 chars for identification (e.g., "sk_live_")
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }), // Track last usage
    expiresAt: timestamp('expires_at', { withTimezone: true }), // Optional expiration
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Performance indexes for API key lookups
    userIdIdx: index('idx_api_keys_user_id').on(table.userId),
    keyPrefixIdx: index('idx_api_keys_key_prefix').on(table.keyPrefix),
    isActiveIdx: index('idx_api_keys_is_active').on(table.isActive),
    // Composite index for active keys by user
    userActiveIdx: index('idx_api_keys_user_active').on(table.userId, table.isActive),
  })
);

// Vaults table - User-defined savings goals with target amounts
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
      .references(() => tokens.id, { onDelete: 'restrict' }), // Vault's target currency
    currentAmount: text('current_amount').notNull().default('0'), // Pre-computed sum of attributed values
    color: text('color').notNull(), // Hex color code (e.g., '#3b82f6')
    iconName: text('icon_name'), // Optional icon identifier for UI
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint for vault name per user
    uniqueUserVaultName: unique().on(table.userId, table.name),
    // Performance index for user queries
    userIdIdx: index('idx_vaults_user_id').on(table.userId),
    // Composite index for active vaults by user
    userActiveIdx: index('idx_vaults_user_active').on(table.userId, table.isActive),
  })
);

// Vault holdings junction table - Links holdings to vaults with a percentage
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
    percentage: real('percentage').notNull(), // 1-100, fraction of holding attributed to this vault
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique constraint to prevent duplicate vault-holding assignments
    uniqueVaultHolding: unique().on(table.vaultId, table.holdingId),
    // Performance indexes for lookups
    vaultIdIdx: index('idx_vault_holdings_vault_id').on(table.vaultId),
    holdingIdIdx: index('idx_vault_holdings_holding_id').on(table.holdingId),
  })
);

// =============================================================================
// RELATIONS
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
  groups: many(groups),
  vaults: many(vaults),
  apiKeys: many(apiKeys),
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
  vaultHoldings: many(vaultHoldings),
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

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
}));

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

export type UserPortfolioEvent = typeof userPortfolioEvents.$inferSelect;
export type NewUserPortfolioEvent = typeof userPortfolioEvents.$inferInsert;

export type UserWallet = typeof userWallets.$inferSelect;
export type NewUserWallet = typeof userWallets.$inferInsert;

export type UserIntegrationCredentials = typeof userIntegrationCredentials.$inferSelect;
export type NewUserIntegrationCredentials = typeof userIntegrationCredentials.$inferInsert;

export type InstitutionBlockchainMapping = typeof institutionBlockchainMappings.$inferSelect;
export type NewInstitutionBlockchainMapping = typeof institutionBlockchainMappings.$inferInsert;

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;

export type HoldingGroup = typeof holdingGroups.$inferSelect;
export type NewHoldingGroup = typeof holdingGroups.$inferInsert;

export type AccountGroup = typeof accountGroups.$inferSelect;
export type NewAccountGroup = typeof accountGroups.$inferInsert;

export type Vault = typeof vaults.$inferSelect;
export type NewVault = typeof vaults.$inferInsert;

export type VaultHolding = typeof vaultHoldings.$inferSelect;
export type NewVaultHolding = typeof vaultHoldings.$inferInsert;
