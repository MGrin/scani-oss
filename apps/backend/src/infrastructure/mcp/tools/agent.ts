import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AgenticUserService } from '@scani/core/services/AgenticUserService';
import { Container } from 'typedi';
import { z } from 'zod';
import { getCurrentUserId } from '../server';
import { createErrorResponse, createSuccessResponse } from './helpers';

const agenticUserService = Container.get(AgenticUserService);

/**
 * Scani MCP capabilities - describes what the API can do
 * Used by agent_getCapabilities for discovery
 */
const SCANI_CAPABILITIES = {
  name: 'Scani Personal Finance API',
  version: '1.0.0',
  description:
    'A comprehensive personal finance management API. Track portfolios, holdings, accounts across banks, brokerages, and crypto exchanges.',
  authentication: {
    type: 'bearer',
    format: 'Authorization: Bearer <apiKey>',
    registration: 'Call agent_register to get your API key (no auth required)',
    expiration: 'API keys never expire unless manually revoked',
  },
  toolCategories: [
    {
      name: 'Agent Management',
      tools: ['agent_register', 'agent_whoami', 'agent_getCapabilities', 'agent_linkToUser'],
      description: 'Register, authenticate, and manage agent identity',
    },
    {
      name: 'Dashboard',
      tools: ['dashboard_getOverview', 'dashboard_getAssetAllocation'],
      description: 'Get portfolio summary, overview, and asset allocation breakdown',
    },
    {
      name: 'Reference Data',
      tools: [
        'accountTypes_getAll',
        'institutionTypes_getAll',
        'tokens_search',
        'tokens_getAll',
        'users_getSupportedCurrencies',
      ],
      description: 'Look up tokens, account types, institution types, and supported currencies',
    },
    {
      name: 'Institutions',
      tools: [
        'institutions_getAll',
        'institutions_getByUserId',
        'institutions_getById',
        'institutions_search',
        'institutions_create',
      ],
      description: 'Manage financial institutions (banks, exchanges, wallets)',
    },
    {
      name: 'Accounts',
      tools: [
        'accounts_getAll',
        'accounts_getByUserIdWithSummary',
        'accounts_getById',
        'accounts_getHoldings',
        'accounts_create',
        'accounts_update',
        'accounts_delete',
        'accounts_bulkDelete',
        'accounts_bulkAssignGroups',
        'accounts_getCommonGroups',
      ],
      description: 'Manage accounts within institutions',
    },
    {
      name: 'Holdings',
      tools: [
        'holdings_getWithDetails',
        'holdings_create',
        'holdings_update',
        'holdings_delete',
        'holdings_bulkDelete',
        'holdings_restore',
        'holdings_updatePrice',
        'holdings_bulkAssignGroups',
        'holdings_getCommonGroups',
      ],
      description: 'Manage asset holdings (stocks, crypto, fiat) within accounts',
    },
    {
      name: 'Groups',
      tools: [
        'groups_getAll',
        'groups_getAllWithCounts',
        'groups_create',
        'groups_update',
        'groups_delete',
        'groups_assignHoldingGroups',
        'groups_assignAccountGroups',
      ],
      description: 'Organise holdings and accounts with colour-coded labels',
    },
    {
      name: 'Wallets',
      tools: ['wallet_getSupportedChains', 'wallet_detectChains', 'wallet_importAddress'],
      description: 'Manage blockchain wallet addresses for automatic on-chain tracking',
    },
    {
      name: 'Portfolio History',
      tools: ['portfolioHistory_getEvents', 'portfolioHistory_getChart'],
      description: 'Query historical portfolio snapshots and performance data',
    },
    {
      name: 'Exchange Integrations',
      tools: ['integrations_binance_validateKeys', 'integrations_kraken_validateKeys'],
      description: 'Connect Binance and Kraken accounts via API keys to auto-import balances',
    },
    {
      name: 'Batch Operations',
      tools: [
        'batchOperations_createHoldingsWithDependencies',
        'batchOperations_updateHoldingsBatch',
      ],
      description: 'Bulk operations for efficient data management',
    },
    {
      name: 'User Settings',
      tools: ['users_getCurrent', 'users_updateCurrent', 'users_getBaseCurrency'],
      description: 'Manage user preferences like base currency',
    },
  ],
  quickStart: [
    '1. Call agent_register with your agent name to get an API key',
    '2. Store the returned apiKey securely - it will not be shown again',
    '3. Include the API key in all subsequent requests: Authorization: Bearer <apiKey>',
    '4. Call dashboard_getOverview to see your portfolio summary',
    '5. Call institutionTypes_getAll and accountTypes_getAll to get valid type IDs',
    '6. Use institutions_create + accounts_create + holdings_create to add financial data',
    '7. Use wallet_importAddress to auto-detect and import on-chain holdings',
    '8. Use integrations_binance_validateKeys or integrations_kraken_validateKeys to link exchanges',
  ],
};

/**
 * Register agent-related MCP tools
 * Includes both authenticated and unauthenticated tools
 */
export function registerAgentTools(server: McpServer) {
  // Get capabilities - UNAUTHENTICATED
  // Allows agents to discover what Scani can do before registering
  server.registerTool(
    'agent_getCapabilities',
    {
      description:
        'Discover Scani API capabilities and available tools. This tool does NOT require authentication. Use this to understand what Scani can do before registering.',
    },
    async (_extra) => {
      return createSuccessResponse(SCANI_CAPABILITIES);
    }
  );

  // Register new agent - UNAUTHENTICATED
  // This tool does NOT require authentication
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'agent_register',
    {
      description: `Register a new AI agent and receive permanent API credentials. This tool does NOT require authentication.

IMPORTANT FOR AGENTS:
- Call this ONLY if you don't have stored Scani credentials
- The returned apiKey is shown ONLY ONCE - you MUST store it persistently
- Credentials never expire - store them for all future sessions
- If you lose your credentials, you must register again (previous data will be inaccessible)

Returns: agentId, apiKey, name, createdAt`,
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(100)
          .describe(
            'A unique name for your agent (e.g., "Claude Finance Assistant", "Cursor AI Helper")'
          ),
      }),
    },
    async (params, _extra) => {
      try {
        const result = await agenticUserService.registerAgent({
          name: params.name,
        });

        return createSuccessResponse({
          success: true,
          message: 'Agent registered successfully!',

          // Core credentials - MUST BE STORED
          credentials: {
            agentId: result.agentId,
            apiKey: result.apiKey,
            warning: 'STORE THESE VALUES NOW - the apiKey will NEVER be shown again!',
          },

          // Agent info
          agent: {
            name: result.name,
            createdAt: result.createdAt.toISOString(),
          },

          // Clear usage instructions
          usage: {
            authentication: {
              header: 'Authorization',
              value: `Bearer ${result.apiKey}`,
              example: `curl -H "Authorization: Bearer ${result.apiKey}" ...`,
            },
            nextSteps: [
              'Store agentId and apiKey in persistent storage',
              'Include Authorization header in all future MCP requests',
              'Call agent_whoami to verify your credentials work',
              'Call dashboard_getSummary to see your portfolio',
            ],
            persistenceHint:
              'Store credentials in your agent memory/state system, environment variables, or secure file storage',
          },
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Who am I - AUTHENTICATED
  // Lets agents verify their credentials and get their info
  server.registerTool(
    'agent_whoami',
    {
      description: `Verify your API credentials and get your agent information. This tool REQUIRES authentication.

Use this to:
- Verify your stored credentials are still valid
- Get your agent ID and name
- Check your current base currency setting
- See if you're linked to a regular user account

If this returns an error, your credentials are invalid and you may need to re-register.`,
    },
    async (_extra) => {
      try {
        const userId = getCurrentUserId();
        const agentInfo = await agenticUserService.getAgentInfo(userId);

        if (!agentInfo) {
          return createErrorResponse(new Error('Agent not found'));
        }

        return createSuccessResponse({
          authenticated: true,
          agent: {
            agentId: agentInfo.agentId,
            name: agentInfo.name,
            userType: agentInfo.userType,
            baseCurrency: agentInfo.baseCurrency,
            linkedToUserId: agentInfo.linkedToUserId,
            createdAt: agentInfo.createdAt.toISOString(),
          },
          status: agentInfo.linkedToUserId
            ? 'Linked to regular user account'
            : 'Standalone agent account',
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Link agent to regular user - AUTHENTICATED (requires the target user's API key)
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'agent_linkToUser',
    {
      description:
        "Link an agentic user to a regular Scani user account. This allows the agent-created data to be associated with a real user. Requires authentication with the target user's API key.",
      inputSchema: z.object({
        agentId: z.string().uuid().describe('The agent ID to link (from agent_register response)'),
      }),
    },
    async (params, _extra) => {
      try {
        // This tool requires authentication - get the authenticated user
        const targetUserId = getCurrentUserId();

        const result = await agenticUserService.linkAgentToUser({
          agentId: params.agentId,
          targetUserId,
        });

        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}

/**
 * Tools that can be called without authentication
 * Used by handleUnauthenticatedMcpRequest
 */
export const UNAUTHENTICATED_TOOLS = ['agent_register', 'agent_getCapabilities'] as const;

/**
 * Check if a tool name is allowed without authentication
 */
export function isUnauthenticatedTool(toolName: string): boolean {
  return UNAUTHENTICATED_TOOLS.includes(toolName as (typeof UNAUTHENTICATED_TOOLS)[number]);
}
