import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AccountImplementations } from '@scani/core/features/implementations';
import { UpdateAccountDto } from '@scani/shared';
import { z } from 'zod';
import { getCurrentUserId } from '../server';
import { createErrorResponse, createSuccessResponse } from './helpers';

/**
 * Register account-related MCP tools
 * Maps to the accounts tRPC router
 */
export function registerAccountsTools(server: McpServer) {
  // Get all accounts - no input
  server.registerTool(
    'accounts_getAll',
    {
      description: 'Get all accounts for the user',
    },
    async (_extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await AccountImplementations.getAll({ userId }, {});
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Get accounts with summary - no input
  server.registerTool(
    'accounts_getByUserIdWithSummary',
    {
      description: 'Get all accounts with summary information',
    },
    async (_extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await AccountImplementations.getByUserIdWithSummary({ userId }, {});
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Get account by ID
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'accounts_getById',
    {
      description: 'Get a specific account by ID',
      inputSchema: z.object({
        id: z.string().uuid().describe('Account ID'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await AccountImplementations.getById({ userId }, { id: params.id });
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Get holdings for an account
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'accounts_getHoldings',
    {
      description: 'Get all holdings for a specific account',
      inputSchema: z.object({
        id: z.string().uuid().describe('Account ID'),
        includeHidden: z.boolean().optional().describe('Include hidden holdings'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await AccountImplementations.getHoldings(
          { userId },
          {
            id: params.id,
            includeHidden: params.includeHidden ?? false,
          }
        );
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Update account
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'accounts_update',
    {
      description: 'Update an account',
      inputSchema: z.object({
        id: z.string().uuid().describe('Account ID'),
        name: z.string().optional().describe('Account name'),
        description: z.string().optional().describe('Account description'),
        isActive: z.boolean().optional().describe('Whether account is active'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const { id, ...data } = params;
        const validatedData = UpdateAccountDto.parse(data);
        const result = await AccountImplementations.update({ userId }, { id, data: validatedData });
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Delete account
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'accounts_delete',
    {
      description: 'Delete an account',
      inputSchema: z.object({
        id: z.string().uuid().describe('Account ID'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await AccountImplementations.delete({ userId }, { id: params.id });
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Bulk delete accounts
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'accounts_bulkDelete',
    {
      description: 'Delete multiple accounts at once',
      inputSchema: z.object({
        ids: z.array(z.string()).describe('Array of account IDs to delete'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await AccountImplementations.bulkDelete({ userId }, { ids: params.ids });
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Bulk assign groups
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'accounts_bulkAssignGroups',
    {
      description: 'Assign groups to multiple accounts',
      inputSchema: z.object({
        accountIds: z.array(z.string()).describe('Array of account IDs'),
        groupIds: z.array(z.string()).describe('Array of group IDs to assign'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await AccountImplementations.bulkAssignGroups(
          { userId },
          {
            accountIds: params.accountIds,
            groupIds: params.groupIds,
          }
        );
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Get common groups
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'accounts_getCommonGroups',
    {
      description: 'Get groups that are common to multiple accounts',
      inputSchema: z.object({
        accountIds: z.array(z.string()).describe('Array of account IDs'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await AccountImplementations.getCommonGroups(
          { userId },
          {
            accountIds: params.accountIds,
          }
        );
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
