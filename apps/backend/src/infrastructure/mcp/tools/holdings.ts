import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HoldingImplementations } from '@scani/core/features/implementations';
import { UpdateHoldingDto } from '@scani/shared';
import { z } from 'zod';
import { getCurrentUserId } from '../server';
import { createErrorResponse, createSuccessResponse } from './helpers';

/**
 * Register holding-related MCP tools
 * Maps to the holdings tRPC router
 */
export function registerHoldingsTools(server: McpServer) {
  // Get holdings with details - no input
  server.registerTool(
    'holdings_getWithDetails',
    {
      description: 'Get all holdings with full details including token prices',
    },
    async (_extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await HoldingImplementations.getWithDetails({ userId }, {});
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Update holding
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'holdings_update',
    {
      description: 'Update a holding',
      inputSchema: z.object({
        id: z.string().describe('Holding ID'),
        balance: z.string().optional().describe('Balance amount'),
        isHidden: z.boolean().optional().describe('Whether holding is hidden'),
        isActive: z.boolean().optional().describe('Whether holding is active'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const { id, ...data } = params;
        const validatedData = UpdateHoldingDto.parse(data);
        const result = await HoldingImplementations.update({ userId }, { id, data: validatedData });
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Delete holding
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'holdings_delete',
    {
      description: 'Delete a holding',
      inputSchema: z.object({
        id: z.string().describe('Holding ID'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await HoldingImplementations.delete({ userId }, { id: params.id });
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Bulk delete holdings
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'holdings_bulkDelete',
    {
      description: 'Delete multiple holdings at once',
      inputSchema: z.object({
        ids: z.array(z.string()).describe('Array of holding IDs to delete'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await HoldingImplementations.bulkDelete({ userId }, { ids: params.ids });
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Restore hidden holding
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'holdings_restore',
    {
      description: 'Restore a hidden holding',
      inputSchema: z.object({
        id: z.string().describe('Holding ID'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await HoldingImplementations.restore({ userId }, { id: params.id });
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Update holding price
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'holdings_updatePrice',
    {
      description: 'Force update holding price from pricing providers',
      inputSchema: z.object({
        id: z.string().describe('Holding ID'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await HoldingImplementations.updatePrice({ userId }, { id: params.id });
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Bulk assign groups
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'holdings_bulkAssignGroups',
    {
      description: 'Assign groups to multiple holdings',
      inputSchema: z.object({
        holdingIds: z.array(z.string()).describe('Array of holding IDs'),
        groupIds: z.array(z.string()).describe('Array of group IDs to assign'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await HoldingImplementations.bulkAssignGroups(
          { userId },
          { holdingIds: params.holdingIds, groupIds: params.groupIds }
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
    'holdings_getCommonGroups',
    {
      description: 'Get groups that are common to multiple holdings',
      inputSchema: z.object({
        holdingIds: z.array(z.string()).describe('Array of holding IDs'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await HoldingImplementations.getCommonGroups(
          { userId },
          { holdingIds: params.holdingIds }
        );
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
