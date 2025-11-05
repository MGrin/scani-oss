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
      'Update a holding (change quantity, cost basis, etc.). Use when user wants to modify an existing holding.',
    parameters: z.object({
      holdingId: z.string().describe('The ID of the holding to update'),
      quantity: z.number().optional().describe('New quantity'),
      costBasis: z.number().optional().describe('New cost basis in base currency'),
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
};

export type ToolName = keyof typeof tools;
