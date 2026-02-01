import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DashboardImplementations } from '@scani/core/features/implementations';
import { GetAssetAllocationInputDto } from '@scani/shared';
import { z } from 'zod';
import { getCurrentUserId } from '../server';
import { createErrorResponse, createSuccessResponse } from './helpers';

/**
 * Register dashboard-related MCP tools
 * Maps to the dashboard tRPC router
 */
export function registerDashboardTools(server: McpServer) {
  // Get dashboard overview - no input
  server.registerTool(
    'dashboard_getOverview',
    {
      description:
        'Get dashboard overview with aggregated portfolio data including value, counts, top holdings, and asset allocation',
    },
    async (_extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await DashboardImplementations.getOverview({ userId }, {});
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Get asset allocation
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'dashboard_getAssetAllocation',
    {
      description: 'Get asset allocation breakdown by dimension',
      inputSchema: z.object({
        dimension: z
          .enum([
            'token',
            'token_type',
            'account',
            'account_type',
            'institution',
            'institution_type',
          ])
          .describe('Dimension to group allocation by'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const validatedInput = GetAssetAllocationInputDto.parse(params);
        const result = await DashboardImplementations.getAssetAllocation(
          { userId },
          validatedInput
        );
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
