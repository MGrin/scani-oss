import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TokenImplementations } from '@scani/core/features/implementations';
import { z } from 'zod';
import { getCurrentUserId } from '../server';
import { createErrorResponse, createSuccessResponse } from './helpers';

/**
 * Register token-related MCP tools
 * Maps to the tokens tRPC router
 */
export function registerTokensTools(server: McpServer) {
  // Search tokens - with input schema
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'tokens_search',
    {
      description: 'Search for tokens by symbol or name',
      inputSchema: z.object({
        query: z.string().describe('Search query for token symbol or name'),
        limit: z.number().optional().describe('Maximum number of results'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await TokenImplementations.search({ userId }, params);
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Get all tokens - no input
  server.registerTool(
    'tokens_getAll',
    {
      description: 'Get all available tokens',
    },
    async (_extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await TokenImplementations.getAll({ userId }, {});
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
