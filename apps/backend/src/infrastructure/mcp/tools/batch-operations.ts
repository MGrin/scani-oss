import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BatchOperationImplementations } from '@scani/core/features/implementations';
import { CreateHoldingsWithDependenciesDto } from '@scani/shared';
import { z } from 'zod';
import { getCurrentUserId } from '../server';
import { createErrorResponse, createSuccessResponse } from './helpers';

/**
 * Register batch operation MCP tools
 * Maps to the batch-operations tRPC router
 */
export function registerBatchOperationsTools(server: McpServer) {
  // Create holdings with dependencies
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'batchOperations_createHoldingsWithDependencies',
    {
      description:
        'Create multiple holdings with automatic account and institution creation if needed',
      inputSchema: z.object({
        accountId: z.string().uuid().optional().describe('Optional account ID to add holdings to'),
        holdings: z
          .array(
            z.object({
              tokenId: z.string().uuid().describe('Token ID'),
              balance: z.string().describe('Balance amount'),
            })
          )
          .describe('Array of holdings to create'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const validatedInput = CreateHoldingsWithDependenciesDto.parse(params);
        const result = await BatchOperationImplementations.createHoldingsWithDependencies(
          { userId },
          validatedInput
        );
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Update holdings batch
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'batchOperations_updateHoldingsBatch',
    {
      description: 'Update multiple holdings in a single batch operation',
      inputSchema: z.object({
        holdings: z
          .array(
            z.object({
              id: z.string().uuid().describe('Holding ID'),
              balance: z
                .string()
                .regex(/^-?\d+\.?\d*$/)
                .describe('Balance amount'),
              lastUpdated: z.string().datetime().optional().describe('Last updated timestamp'),
            })
          )
          .min(1)
          .describe('Array of holdings to update'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await BatchOperationImplementations.updateHoldingsBatch({ userId }, params);
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
