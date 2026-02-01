import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SettingsImplementations } from '@scani/core/features/implementations';
import { UpdateUserDto } from '@scani/shared';
import { z } from 'zod';
import { getCurrentUserId } from '../server';
import { createErrorResponse, createSuccessResponse } from './helpers';

/**
 * Register user-related MCP tools
 * Maps to the users tRPC router (excluding user creation)
 */
export function registerUsersTools(server: McpServer) {
  // Get current user profile - no input
  server.registerTool(
    'users_getCurrent',
    {
      description: 'Get the current authenticated user profile',
    },
    async (_extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await SettingsImplementations.getCurrent({ userId }, {});
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Update current user
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'users_updateCurrent',
    {
      description: 'Update the current user profile',
      inputSchema: z.object({
        name: z.string().min(1).optional().describe('User name'),
        avatar: z.string().url().nullable().optional().describe('Avatar URL'),
        baseCurrencyId: z.string().uuid().nullable().optional().describe('Base currency ID'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();

        // Validate input using the same DTO as tRPC
        const validatedInput = UpdateUserDto.parse(params);

        const result = await SettingsImplementations.updateCurrent({ userId }, validatedInput);
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Get supported currencies for base currency selection - no input
  server.registerTool(
    'users_getSupportedCurrencies',
    {
      description: 'Get list of supported fiat currencies for base currency selection',
    },
    async (_extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await SettingsImplementations.getSupportedCurrencies({ userId }, {});
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Get user's base currency - no input
  server.registerTool(
    'users_getBaseCurrency',
    {
      description: "Get the user's configured base currency",
    },
    async (_extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await SettingsImplementations.getBaseCurrency({ userId }, {});
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
