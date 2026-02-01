import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InstitutionImplementations } from '@scani/core/features/implementations';
import { z } from 'zod';
import { getCurrentUserId } from '../server';
import { createErrorResponse, createSuccessResponse } from './helpers';

interface Institution {
  name: string;
  [key: string]: unknown;
}

/**
 * Register institution-related MCP tools
 * Maps to the institutions tRPC router
 */
export function registerInstitutionsTools(server: McpServer) {
  // Get all institutions - no input
  server.registerTool(
    'institutions_getAll',
    {
      description: 'Get all available institutions',
    },
    async (_extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await InstitutionImplementations.getAll({ userId }, {});
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Search institutions - implemented as client-side filter since search() doesn't exist
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'institutions_search',
    {
      description: 'Search for institutions by name',
      inputSchema: z.object({
        query: z.string().describe('Search query'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const allInstitutions = await InstitutionImplementations.getAll({ userId }, {});
        const searchLower = params.query.toLowerCase();
        const result = (allInstitutions as Institution[]).filter((inst) =>
          inst.name.toLowerCase().includes(searchLower)
        );
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Get institution by ID
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'institutions_getById',
    {
      description: 'Get a specific institution by ID',
      inputSchema: z.object({
        id: z.string().uuid().describe('Institution ID'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await InstitutionImplementations.getById({ userId }, { id: params.id });
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
