import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GroupImplementations } from '@scani/core/features/implementations';
import { z } from 'zod';
import { getCurrentUserId } from '../server';
import { createErrorResponse, createSuccessResponse } from './helpers';

/**
 * Register group-related MCP tools
 * Maps to the groups tRPC router
 *
 * Groups are organisational labels (with colours) that can be assigned to both
 * holdings and accounts for custom portfolio segmentation.
 */
export function registerGroupsTools(server: McpServer) {
  // Get all groups - no input
  server.registerTool(
    'groups_getAll',
    {
      description: 'Get all groups for the user',
    },
    async (_extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await GroupImplementations.getAll({ userId }, {});
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Get all groups with holding/account counts - no input
  server.registerTool(
    'groups_getAllWithCounts',
    {
      description: 'Get all groups with the number of holdings and accounts assigned to each',
    },
    async (_extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await GroupImplementations.getAllWithCounts({ userId }, {});
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Create a new group
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'groups_create',
    {
      description:
        'Create a new group for organising holdings and accounts. Provide a name and a hex colour.',
      inputSchema: z.object({
        name: z.string().min(1).max(50).describe('Group name'),
        color: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .describe('Hex colour code, e.g. "#3b82f6"'),
        description: z.string().max(200).optional().nullable().describe('Optional description'),
        displayOrder: z.number().optional().describe('Sort order (lower = first)'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await GroupImplementations.create({ userId }, params);
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Update a group
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'groups_update',
    {
      description: 'Update an existing group',
      inputSchema: z.object({
        id: z.string().uuid().describe('Group ID'),
        name: z.string().min(1).max(50).optional().describe('New name'),
        color: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional()
          .describe('New hex colour'),
        description: z.string().max(200).optional().nullable().describe('New description'),
        displayOrder: z.number().optional().describe('New sort order'),
        isActive: z.boolean().optional().describe('Active flag'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const { id, ...data } = params;
        const result = await GroupImplementations.update({ userId }, { id, data });
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Delete a group
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'groups_delete',
    {
      description: 'Delete a group. This unassigns it from all holdings and accounts.',
      inputSchema: z.object({
        id: z.string().uuid().describe('Group ID'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await GroupImplementations.delete({ userId }, { id: params.id });
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Assign groups to a holding
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'groups_assignHoldingGroups',
    {
      description: 'Set the groups assigned to a specific holding (replaces current assignment)',
      inputSchema: z.object({
        holdingId: z.string().uuid().describe('Holding ID'),
        groupIds: z.array(z.string().uuid()).describe('Group IDs to assign (empty = remove all)'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await GroupImplementations.assignHoldingGroups({ userId }, params);
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Assign groups to an account
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'groups_assignAccountGroups',
    {
      description: 'Set the groups assigned to a specific account (replaces current assignment)',
      inputSchema: z.object({
        accountId: z.string().uuid().describe('Account ID'),
        groupIds: z.array(z.string().uuid()).describe('Group IDs to assign (empty = remove all)'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await GroupImplementations.assignAccountGroups({ userId }, params);
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
