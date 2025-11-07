import { z } from 'zod';

/**
 * Tool definitions for the AI agent
 * These tools allow the AI to interact with the tRPC backend
 */

export const tools = {
  // Dashboard operations
  getDashboardOverview: {
    description:
      'Get a comprehensive overview of the user portfolio including total value, asset counts, top holdings, and asset allocation. Use this when the user asks about their portfolio summary, total value, or general overview.',
    parameters: z.object({}),
  },

  // Account operations
  listAccounts: {
    description:
      'List all accounts (investment accounts, bank accounts, etc.) for the user. Returns account names, types, institutions, and basic information.',
    parameters: z.object({}),
  },

  getAccountDetails: {
    description:
      'Get detailed information about a specific account including all holdings. Use when user asks about a specific account.',
    parameters: z.object({
      accountId: z.string().describe('The ID of the account to fetch details for'),
    }),
  },

  deleteAccount: {
    description:
      'Delete an account and all its holdings. Use with caution - this is a destructive operation. Ask for confirmation first.',
    parameters: z.object({
      accountId: z.string().describe('The ID of the account to delete'),
    }),
  },

  // Holdings operations
  listHoldings: {
    description:
      'List all holdings (stocks, crypto, etc.) across all accounts or for a specific account. Shows current quantities, prices, and values.',
    parameters: z.object({
      accountId: z.string().optional().describe('Optional: Filter holdings by account ID'),
    }),
  },

  updateHolding: {
    description:
      'Update a holding quantity. Use when user wants to modify the amount of a holding they own.',
    parameters: z.object({
      holdingId: z.string().describe('The ID of the holding to update'),
      quantity: z.number().optional().describe('New quantity/balance'),
    }),
  },

  deleteHolding: {
    description: 'Delete a holding from an account. Use with caution - ask for confirmation first.',
    parameters: z.object({
      holdingId: z.string().describe('The ID of the holding to delete'),
    }),
  },

  // Token operations
  searchTokens: {
    description:
      'Search for tokens (stocks, cryptocurrencies, fiat currencies) by symbol or name. Use this to find token information or validate token symbols.',
    parameters: z.object({
      query: z
        .string()
        .describe('Search query - can be symbol (e.g., "AAPL", "BTC") or name (e.g., "Apple")'),
      limit: z.number().optional().default(10).describe('Maximum number of results to return'),
    }),
  },

  getTokenPrice: {
    description:
      'Get the current price of a specific token. Use when user asks about current price of a stock or crypto.',
    parameters: z.object({
      symbol: z.string().describe('Token symbol (e.g., "AAPL", "BTC", "ETH")'),
    }),
  },

  // Institution operations
  listInstitutions: {
    description:
      'List all available institutions (banks, brokers, exchanges). Use when user wants to see available institutions or search for one.',
    parameters: z.object({
      type: z
        .string()
        .optional()
        .describe('Optional: Filter by institution type (e.g., "bank", "broker")'),
    }),
  },

  // Batch operations
  importHoldings: {
    description:
      'Bulk import multiple holdings at once. Use when user provides a list of holdings to add (e.g., from a screenshot or manual list).',
    parameters: z.object({
      accountId: z.string().describe('The account ID to add holdings to'),
      holdings: z
        .array(
          z.object({
            tokenSymbol: z.string().describe('Token symbol (e.g., "AAPL", "BTC")'),
            quantity: z.number().describe('Quantity/amount'),
            costBasis: z
              .number()
              .optional()
              .describe('Optional: Cost basis in base currency per unit'),
          })
        )
        .describe('Array of holdings to import'),
    }),
  },

  // Institution type operations
  listInstitutionTypes: {
    description:
      'List all available institution types (bank, broker, exchange, etc.). Use when user wants to know what types of institutions are supported.',
    parameters: z.object({}),
  },

  // Account type operations
  listAccountTypes: {
    description:
      'List all available account types (checking, savings, brokerage, crypto, etc.). Use when user wants to know what types of accounts are supported.',
    parameters: z.object({}),
  },

  // Wallet operations
  importWallet: {
    description:
      'Import a crypto wallet address. Automatically detects chains, fetches balances, and creates accounts with holdings. Use when user provides a wallet address to import.',
    parameters: z.object({
      address: z.string().describe('Wallet address to import (Ethereum, Bitcoin, Solana, etc.)'),
      displayName: z
        .string()
        .optional()
        .describe('Optional display name for the wallet (defaults to shortened address)'),
    }),
  },

  listSupportedChains: {
    description:
      'List all supported blockchain chains for wallet import. Use when user asks what blockchains are supported.',
    parameters: z.object({}),
  },

  // Chart/Visualization operations
  getPortfolioByTokens: {
    description:
      'Get portfolio breakdown grouped by individual tokens (e.g., BTC, ETH, AAPL). Shows each token with total balance across all accounts, current value, and percentage. Use for creating donut or bar charts by token, or when user asks about their holdings by token.',
    parameters: z.object({}),
  },

  getPortfolioByAccounts: {
    description:
      'Get portfolio breakdown grouped by accounts (e.g., "Coinbase", "Robinhood", "Checking Account"). Shows each account with total value and percentage. Use for creating donut or bar charts by account, or when user asks about distribution across accounts.',
    parameters: z.object({}),
  },

  getPortfolioByInstitutions: {
    description:
      'Get portfolio breakdown grouped by institutions (e.g., "Coinbase", "Chase", "Vanguard"). Shows each institution with total value and percentage. Use for creating donut or bar charts by institution, or when user asks about distribution across institutions.',
    parameters: z.object({}),
  },

  getPortfolioByTokenTypes: {
    description:
      'Get portfolio breakdown grouped by token types (e.g., "Cryptocurrency", "Stock", "Fiat"). Shows asset allocation with value and percentage for each type. Use for creating donut or bar charts by asset type, or when user asks about asset allocation.',
    parameters: z.object({}),
  },

  // Chart generation operations
  generatePortfolioChart: {
    description:
      'Generate a visual chart image for portfolio data. Creates donut charts for distribution (tokens, accounts, institutions, asset types) or bar charts for comparisons. Returns an image that can be sent to the user. Use when user asks for a chart, graph, or visual representation of their portfolio.',
    parameters: z.object({
      chartType: z
        .enum(['donut', 'bar'])
        .describe('Type of chart: donut for distribution, bar for comparisons'),
      dataType: z
        .enum(['tokens', 'accounts', 'institutions', 'tokenTypes'])
        .describe(
          'What to chart: tokens (individual holdings), accounts, institutions, or tokenTypes (asset allocation)'
        ),
    }),
  },
};

export type ToolName = keyof typeof tools;
