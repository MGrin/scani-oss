/**
 * Feature Registry
 *
 * This module defines all user-facing features available in the application.
 * Each feature maps to one or more backend procedures and can be consumed by:
 * - Frontend UI via tRPC
 * - Telegram Bot via AI Agent tools
 * - CLI tools
 *
 * Features are organized by category for easy discovery and maintenance.
 */

import { z } from 'zod';
import {
  AccountImplementations,
  BatchOperationImplementations,
  DashboardImplementations,
  HoldingImplementations,
  InstitutionImplementations,
  ScreenshotImplementations,
  SettingsImplementations,
  TokenImplementations,
  TypeImplementations,
  WalletImplementations,
} from './implementations';

/**
 * Feature categories align with main app sections
 */
export enum FeatureCategory {
  DASHBOARD = 'dashboard',
  ACCOUNTS = 'accounts',
  HOLDINGS = 'holdings',
  INSTITUTIONS = 'institutions',
  TOKENS = 'tokens',
  WALLET = 'wallet',
  BATCH_OPERATIONS = 'batch_operations',
  SCREENSHOTS = 'screenshots',
  SETTINGS = 'settings',
}

/**
 * Execution context for features
 * Provides necessary authentication and user data
 */
export interface FeatureExecutionContext {
  /** Authenticated user ID */
  userId: string;
  /** Full user object from database (optional, fetched if needed) */
  dbUser?: {
    id: string;
    baseCurrencyId?: string | null;
    // biome-ignore lint/suspicious/noExplicitAny: User object can have additional dynamic properties
    [key: string]: any;
  };
}

/**
 * Feature definition
 * Describes what a feature does, how to invoke it, and contains the implementation
 */
// biome-ignore lint/suspicious/noExplicitAny: Feature types are dynamically inferred based on implementation
export interface Feature<TInput = any, TOutput = any> {
  /** Unique feature identifier */
  id: string;

  /** Feature category */
  category: FeatureCategory;

  /** Human-readable name */
  name: string;

  /** Detailed description for AI agents and documentation */
  description: string;

  /** tRPC procedure path (e.g., "dashboard.getOverview") */
  procedurePath: string;

  /** Zod schema for input parameters */
  inputSchema: z.ZodType<TInput>;

  /** Whether this feature modifies data (mutation vs query) */
  isMutation: boolean;

  /** Whether this feature requires authentication */
  requiresAuth: boolean;

  /** Tags for filtering and search */
  tags: string[];

  /** Examples of how to use this feature */
  examples?: string[];

  /**
   * Feature implementation
   * This function executes the actual feature logic
   * Can be called from tRPC routers or Telegram bot
   */
  execute: (context: FeatureExecutionContext, input: TInput) => Promise<TOutput>;
}

/**
 * Dashboard Features
 */
export const DASHBOARD_FEATURES: Feature[] = [
  {
    id: 'dashboard.getOverview',
    category: FeatureCategory.DASHBOARD,
    name: 'Get Dashboard Overview',
    description:
      'Get a comprehensive overview of the user portfolio including total value, asset counts, top holdings, and asset allocation. Use this when the user asks about their portfolio summary, total value, or general overview.',
    procedurePath: 'dashboard.getOverview',
    inputSchema: z.object({}),
    isMutation: false,
    requiresAuth: true,
    tags: ['portfolio', 'overview', 'summary', 'dashboard'],
    examples: [
      'Show me my portfolio overview',
      'What is my total portfolio value?',
      'Give me a summary of my investments',
    ],
    execute: DashboardImplementations.getOverview,
  },
  {
    id: 'dashboard.getAssetAllocation',
    category: FeatureCategory.DASHBOARD,
    name: 'Get Asset Allocation',
    description:
      'Get asset allocation by a specific dimension (token, token_type, account, account_type, institution, institution_type). Shows how portfolio is distributed across different categories.',
    procedurePath: 'dashboard.getAssetAllocation',
    inputSchema: z.object({
      dimension: z.enum([
        'token',
        'token_type',
        'account',
        'account_type',
        'institution',
        'institution_type',
      ]),
    }),
    isMutation: false,
    requiresAuth: true,
    tags: ['allocation', 'distribution', 'breakdown', 'diversification'],
    examples: [
      'Show my asset allocation by token type',
      'How is my portfolio distributed across institutions?',
      'Break down my holdings by account',
    ],
    execute: DashboardImplementations.getAssetAllocation,
  },
];

/**
 * Account Features
 */
export const ACCOUNT_FEATURES: Feature[] = [
  {
    id: 'accounts.getAll',
    category: FeatureCategory.ACCOUNTS,
    name: 'List All Accounts',
    description:
      'List all accounts (investment accounts, bank accounts, etc.) for the user. Returns account names, types, institutions, and basic information.',
    procedurePath: 'accounts.getAll',
    inputSchema: z.object({}),
    isMutation: false,
    requiresAuth: true,
    tags: ['accounts', 'list', 'view'],
    examples: [
      'List all my accounts',
      'Show me all my investment accounts',
      'What accounts do I have?',
    ],
    execute: AccountImplementations.getAll,
  },
  {
    id: 'accounts.getByUserIdWithSummary',
    category: FeatureCategory.ACCOUNTS,
    name: 'List Accounts with Summary',
    description:
      'List all accounts with summary information including total value and holdings count for each account.',
    procedurePath: 'accounts.getByUserIdWithSummary',
    inputSchema: z.object({}),
    isMutation: false,
    requiresAuth: true,
    tags: ['accounts', 'summary', 'value'],
    examples: ['Show my accounts with their values', 'List accounts with summary'],
    execute: AccountImplementations.getByUserIdWithSummary,
  },
  {
    id: 'accounts.getById',
    category: FeatureCategory.ACCOUNTS,
    name: 'Get Account Details',
    description:
      'Get detailed information about a specific account including all holdings. Use when user asks about a specific account.',
    procedurePath: 'accounts.getById',
    inputSchema: z.object({
      id: z.string().uuid(),
    }),
    isMutation: false,
    requiresAuth: true,
    tags: ['account', 'details', 'view'],
    examples: ['Show me details of account X', 'What holdings are in my Coinbase account?'],
    execute: AccountImplementations.getById,
  },
  {
    id: 'accounts.getHoldings',
    category: FeatureCategory.ACCOUNTS,
    name: 'Get Account Holdings',
    description: 'Get all holdings for a specific account with complete token and pricing details.',
    procedurePath: 'accounts.getHoldings',
    inputSchema: z.object({
      id: z.string().uuid(),
    }),
    isMutation: false,
    requiresAuth: true,
    tags: ['account', 'holdings', 'view'],
    examples: ['Show holdings in my Robinhood account', 'What do I own in account X?'],
    execute: AccountImplementations.getHoldings,
  },
  {
    id: 'accounts.delete',
    category: FeatureCategory.ACCOUNTS,
    name: 'Delete Account',
    description:
      'Delete an account and all its holdings. Use with caution - this is a destructive operation. Ask for confirmation first.',
    procedurePath: 'accounts.delete',
    inputSchema: z.object({
      id: z.string().uuid(),
    }),
    isMutation: true,
    requiresAuth: true,
    tags: ['account', 'delete', 'remove'],
    examples: ['Delete my old bank account', 'Remove account X'],
    execute: AccountImplementations.delete,
  },
  {
    id: 'accountTypes.getAll',
    category: FeatureCategory.ACCOUNTS,
    name: 'List Account Types',
    description:
      'List all available account types (checking, savings, brokerage, crypto, etc.). Use when user wants to know what types of accounts are supported.',
    procedurePath: 'accountTypes.getAll',
    inputSchema: z.object({}),
    isMutation: false,
    requiresAuth: true,
    tags: ['account-types', 'types', 'categories'],
    examples: ['What account types are available?', 'List account categories'],
    execute: TypeImplementations.getAccountTypes,
  },
];

/**
 * Holdings Features
 */
export const HOLDINGS_FEATURES: Feature[] = [
  {
    id: 'holdings.getWithDetails',
    category: FeatureCategory.HOLDINGS,
    name: 'List Holdings with Details',
    description:
      'List all holdings across all accounts with complete details including token information, current prices, and values.',
    procedurePath: 'holdings.getWithDetails',
    inputSchema: z.object({}),
    isMutation: false,
    requiresAuth: true,
    tags: ['holdings', 'list', 'view', 'portfolio'],
    examples: ['List all my holdings', 'Show me what I own', 'What stocks and crypto do I have?'],
    execute: HoldingImplementations.getWithDetails,
  },
  {
    id: 'holdings.update',
    category: FeatureCategory.HOLDINGS,
    name: 'Update Holding',
    description:
      'Update a holding quantity or other properties. Use when user wants to modify a holding.',
    procedurePath: 'holdings.update',
    inputSchema: z.object({
      id: z.string().uuid(),
      data: z.object({
        balance: z.string().optional(),
        costBasis: z.string().optional(),
      }),
    }),
    isMutation: true,
    requiresAuth: true,
    tags: ['holding', 'update', 'modify', 'edit'],
    examples: ['Update my BTC balance to 2.5', 'Change the quantity of holding X'],
    execute: HoldingImplementations.update,
  },
  {
    id: 'holdings.delete',
    category: FeatureCategory.HOLDINGS,
    name: 'Delete Holding',
    description: 'Delete a holding from an account. Use with caution - ask for confirmation first.',
    procedurePath: 'holdings.delete',
    inputSchema: z.object({
      id: z.string().uuid(),
    }),
    isMutation: true,
    requiresAuth: true,
    tags: ['holding', 'delete', 'remove'],
    examples: ['Delete my Apple stock holding', 'Remove holding X'],
    execute: HoldingImplementations.delete,
  },
  {
    id: 'holdings.updatePrice',
    category: FeatureCategory.HOLDINGS,
    name: 'Update Holding Price',
    description:
      'Force refresh the current price for a holding by fetching latest data from pricing providers.',
    procedurePath: 'holdings.updatePrice',
    inputSchema: z.object({
      id: z.string().uuid(),
    }),
    isMutation: true,
    requiresAuth: true,
    tags: ['holding', 'price', 'refresh', 'update'],
    examples: ['Refresh the price for my Bitcoin holding', 'Update price for holding X'],
    execute: HoldingImplementations.updatePrice,
  },
];

/**
 * Institution Features
 */
export const INSTITUTION_FEATURES: Feature[] = [
  {
    id: 'institutions.getAll',
    category: FeatureCategory.INSTITUTIONS,
    name: 'List All Institutions',
    description:
      'List all available institutions (banks, brokers, exchanges). Use when user wants to see available institutions or search for one.',
    procedurePath: 'institutions.getAll',
    inputSchema: z.object({}),
    isMutation: false,
    requiresAuth: true,
    tags: ['institutions', 'list', 'view'],
    examples: ['List all institutions', 'What banks are supported?', 'Show me available brokers'],
    execute: InstitutionImplementations.getAll,
  },
  {
    id: 'institutions.getByUserId',
    category: FeatureCategory.INSTITUTIONS,
    name: 'List User Institutions',
    description: 'List institutions that the user has accounts with.',
    procedurePath: 'institutions.getByUserId',
    inputSchema: z.object({}),
    isMutation: false,
    requiresAuth: true,
    tags: ['institutions', 'user', 'my'],
    examples: ['Which institutions do I use?', 'Show my banks and brokers'],
    execute: InstitutionImplementations.getByUserId,
  },
  {
    id: 'institutions.getByUserIdWithSummary',
    category: FeatureCategory.INSTITUTIONS,
    name: 'List User Institutions with Summary',
    description:
      'List institutions that the user has accounts with, including summary information like total value and account count.',
    procedurePath: 'institutions.getByUserIdWithSummary',
    inputSchema: z.object({}),
    isMutation: false,
    requiresAuth: true,
    tags: ['institutions', 'summary', 'value'],
    examples: ['Show my institutions with their values', 'How much do I have in each institution?'],
    execute: InstitutionImplementations.getByUserIdWithSummary,
  },
  {
    id: 'institutions.getById',
    category: FeatureCategory.INSTITUTIONS,
    name: 'Get Institution Details',
    description: 'Get detailed information about a specific institution.',
    procedurePath: 'institutions.getById',
    inputSchema: z.object({
      id: z.string().uuid(),
    }),
    isMutation: false,
    requiresAuth: true,
    tags: ['institution', 'details', 'view'],
    examples: ['Show details for Coinbase', 'Tell me about institution X'],
    execute: InstitutionImplementations.getById,
  },
  {
    id: 'institutionTypes.getAll',
    category: FeatureCategory.INSTITUTIONS,
    name: 'List Institution Types',
    description:
      'List all available institution types (bank, broker, exchange, etc.). Use when user wants to know what types of institutions are supported.',
    procedurePath: 'institutionTypes.getAll',
    inputSchema: z.object({}),
    isMutation: false,
    requiresAuth: true,
    tags: ['institution-types', 'types', 'categories'],
    examples: ['What types of institutions are supported?', 'List institution categories'],
    execute: TypeImplementations.getInstitutionTypes,
  },
];

/**
 * Token Features
 */
export const TOKEN_FEATURES: Feature[] = [
  {
    id: 'tokens.getAll',
    category: FeatureCategory.TOKENS,
    name: 'List All Tokens',
    description:
      'List all active tokens (stocks, cryptocurrencies, fiat currencies) in the database.',
    procedurePath: 'tokens.getAll',
    inputSchema: z.object({}),
    isMutation: false,
    requiresAuth: true,
    tags: ['tokens', 'list', 'view'],
    execute: TokenImplementations.getAll,
  },
  {
    id: 'tokens.search',
    category: FeatureCategory.TOKENS,
    name: 'Search Tokens',
    description:
      'Search for tokens (stocks, cryptocurrencies, fiat currencies) by symbol or name. Use this to find token information or validate token symbols.',
    procedurePath: 'tokens.search',
    inputSchema: z.object({
      query: z.string().min(1).max(20),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    isMutation: false,
    requiresAuth: true,
    tags: ['tokens', 'search', 'find', 'lookup'],
    examples: ['Search for Apple stock', 'Find BTC', 'Look up AAPL'],
    execute: TokenImplementations.search,
  },
];

/**
 * Wallet Features
 */
export const WALLET_FEATURES: Feature[] = [
  {
    id: 'wallet.getSupportedChains',
    category: FeatureCategory.WALLET,
    name: 'List Supported Chains',
    description:
      'List all supported blockchain chains for wallet import. Use when user asks what blockchains are supported.',
    procedurePath: 'wallet.getSupportedChains',
    inputSchema: z.object({}),
    isMutation: false,
    requiresAuth: true,
    tags: ['wallet', 'blockchain', 'chains', 'crypto'],
    examples: [
      'What blockchains can I import?',
      'Which chains are supported?',
      'List available networks',
    ],
    execute: WalletImplementations.getSupportedChains,
  },
  {
    id: 'wallet.importAddress',
    category: FeatureCategory.WALLET,
    name: 'Import Wallet Address',
    description:
      'Import a crypto wallet address. Automatically detects chains, fetches balances, and creates accounts with holdings. Use when user provides a wallet address to import.',
    procedurePath: 'wallet.importAddress',
    inputSchema: z.object({
      address: z.string().min(1).max(200),
      displayName: z.string().max(100).optional(),
    }),
    isMutation: true,
    requiresAuth: true,
    tags: ['wallet', 'import', 'crypto', 'blockchain'],
    examples: ['Import my Ethereum wallet 0x123...', 'Add my crypto wallet'],
    execute: WalletImplementations.importAddress,
  },
  {
    id: 'wallet.detectChains',
    category: FeatureCategory.WALLET,
    name: 'Detect Wallet Chains',
    description:
      'Detect which chains a wallet address exists on. Useful for preview before import.',
    procedurePath: 'wallet.detectChains',
    inputSchema: z.object({
      address: z.string().min(1).max(200),
    }),
    isMutation: true,
    requiresAuth: true,
    tags: ['wallet', 'detect', 'preview', 'chains'],
    examples: ['Which chains is this wallet on?', 'Check wallet 0x123...'],
    execute: WalletImplementations.detectChains,
  },
];

/**
 * Batch Operation Features
 */
export const BATCH_OPERATION_FEATURES: Feature[] = [
  {
    id: 'batchOperations.createHoldingsWithDependencies',
    category: FeatureCategory.BATCH_OPERATIONS,
    name: 'Bulk Create Holdings',
    description:
      'Bulk import multiple holdings at once. Automatically creates missing tokens, institutions, and accounts as needed. Use when user provides a list of holdings to add.',
    procedurePath: 'batchOperations.createHoldingsWithDependencies',
    inputSchema: z.object({
      accountId: z.string().uuid().optional(),
      holdings: z.array(
        z.object({
          tokenId: z.string().uuid(),
          balance: z.string(),
        })
      ),
    }),
    isMutation: true,
    requiresAuth: true,
    tags: ['batch', 'import', 'bulk', 'holdings'],
    examples: ['Import multiple holdings from a list', 'Bulk add stocks and crypto'],
    execute: BatchOperationImplementations.createHoldingsWithDependencies,
  },
  {
    id: 'batchOperations.updateHoldingsBatch',
    category: FeatureCategory.BATCH_OPERATIONS,
    name: 'Batch Update Holdings',
    description:
      'Update multiple holdings at once. Useful for bulk updates after account sync or manual adjustments.',
    procedurePath: 'batchOperations.updateHoldingsBatch',
    inputSchema: z.object({
      holdings: z.array(
        z.object({
          id: z.string().uuid(),
          balance: z.string(),
          lastUpdated: z.string().datetime().optional(),
        })
      ),
    }),
    isMutation: true,
    requiresAuth: true,
    tags: ['batch', 'update', 'bulk', 'holdings'],
    examples: ['Update multiple holdings at once', 'Bulk update balances'],
    execute: BatchOperationImplementations.updateHoldingsBatch,
  },
];

/**
 * Screenshot Features
 */
export const SCREENSHOT_FEATURES: Feature[] = [
  {
    id: 'screenshots.parseScreenshots',
    category: FeatureCategory.SCREENSHOTS,
    name: 'Parse Screenshots',
    description:
      'Parse screenshots using AI to extract holdings data. Supports multiple files and various account types. Returns parsed holdings that can be imported.',
    procedurePath: 'screenshots.parseScreenshots',
    inputSchema: z.object({
      files: z.array(
        z.object({
          filename: z.string(),
          data: z.string(),
          contentType: z.string().optional(),
        })
      ),
      provider: z.enum(['openai', 'perplexity', 'deepseek']).optional(),
      accountType: z.string().optional(),
      expectedCurrency: z.string().optional(),
      context: z.string().optional(),
      minConfidence: z.number().min(0).max(1).default(0.5),
      accountId: z.string().optional(),
    }),
    isMutation: true,
    requiresAuth: true,
    tags: ['screenshot', 'ai', 'parse', 'ocr', 'import'],
    examples: [
      'Parse this screenshot of my brokerage account',
      'Extract holdings from these images',
    ],
    execute: ScreenshotImplementations.parseScreenshots,
  },
];

/**
 * Settings Features
 */
export const SETTINGS_FEATURES: Feature[] = [
  {
    id: 'users.getCurrent',
    category: FeatureCategory.SETTINGS,
    name: 'Get Current User',
    description: 'Get current authenticated user information including preferences and settings.',
    procedurePath: 'users.getCurrent',
    inputSchema: z.object({}),
    isMutation: false,
    requiresAuth: true,
    tags: ['user', 'profile', 'settings'],
    execute: SettingsImplementations.getCurrent,
  },
  {
    id: 'users.updateCurrent',
    category: FeatureCategory.SETTINGS,
    name: 'Update User Settings',
    description: 'Update user settings including base currency preference.',
    procedurePath: 'users.updateCurrent',
    inputSchema: z.object({
      baseCurrencyId: z.string().uuid().optional(),
    }),
    isMutation: true,
    requiresAuth: true,
    tags: ['user', 'settings', 'update', 'preferences'],
    examples: ['Change my base currency to EUR', 'Update my settings'],
    execute: SettingsImplementations.updateCurrent,
  },
  {
    id: 'users.getSupportedCurrencies',
    category: FeatureCategory.SETTINGS,
    name: 'List Supported Currencies',
    description: 'Get list of supported fiat currencies that can be used as base currency.',
    procedurePath: 'users.getSupportedCurrencies',
    inputSchema: z.object({}),
    isMutation: false,
    requiresAuth: true,
    tags: ['currencies', 'fiat', 'settings'],
    examples: ['What currencies are supported?', 'List available base currencies'],
    execute: SettingsImplementations.getSupportedCurrencies,
  },
  {
    id: 'users.getBaseCurrency',
    category: FeatureCategory.SETTINGS,
    name: 'Get Base Currency',
    description: "Get the user's current base currency setting.",
    procedurePath: 'users.getBaseCurrency',
    inputSchema: z.object({}),
    isMutation: false,
    requiresAuth: true,
    tags: ['currency', 'settings'],
    execute: SettingsImplementations.getBaseCurrency,
  },
];

/**
 * All features registry
 */
export const ALL_FEATURES: Feature[] = [
  ...DASHBOARD_FEATURES,
  ...ACCOUNT_FEATURES,
  ...HOLDINGS_FEATURES,
  ...INSTITUTION_FEATURES,
  ...TOKEN_FEATURES,
  ...WALLET_FEATURES,
  ...BATCH_OPERATION_FEATURES,
  ...SCREENSHOT_FEATURES,
  ...SETTINGS_FEATURES,
];

/**
 * Get features by category
 */
export function getFeaturesByCategory(category: FeatureCategory): Feature[] {
  return ALL_FEATURES.filter((f) => f.category === category);
}

/**
 * Get feature by ID
 */
export function getFeatureById(id: string): Feature | undefined {
  return ALL_FEATURES.find((f) => f.id === id);
}

/**
 * Search features by tags or name
 */
export function searchFeatures(query: string): Feature[] {
  const lowerQuery = query.toLowerCase();
  return ALL_FEATURES.filter(
    (f) =>
      f.name.toLowerCase().includes(lowerQuery) ||
      f.description.toLowerCase().includes(lowerQuery) ||
      f.tags.some((tag) => tag.toLowerCase().includes(lowerQuery))
  );
}

/**
 * Get all feature categories with counts
 */
export function getFeatureCategorySummary(): {
  category: FeatureCategory;
  count: number;
  features: Feature[];
}[] {
  const categories = Object.values(FeatureCategory);
  return categories.map((category) => ({
    category,
    count: getFeaturesByCategory(category).length,
    features: getFeaturesByCategory(category),
  }));
}
