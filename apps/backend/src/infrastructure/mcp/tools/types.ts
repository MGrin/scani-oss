import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TypeImplementations } from '@scani/core/features/implementations';
import { getCurrentUserId } from '../server';
import { createErrorResponse, createSuccessResponse } from './helpers';

/**
 * Register type-related MCP tools
 * Maps to the account-types and institution-types tRPC routers
 */
export function registerTypesTools(server: McpServer) {
  // Get all account types
  server.registerTool(
    'accountTypes_getAll',
    {
      description: 'Get all available account types',
    },
    async (_extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await TypeImplementations.getAccountTypes({ userId }, {});
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Get all institution types
  server.registerTool(
    'institutionTypes_getAll',
    {
      description: 'Get all available institution types',
    },
    async (_extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await TypeImplementations.getInstitutionTypes({ userId }, {});
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
