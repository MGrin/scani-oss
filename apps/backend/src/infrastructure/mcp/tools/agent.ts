import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AgenticUserService } from '@scani/core/services/AgenticUserService';
import { Container } from 'typedi';
import { z } from 'zod';
import { getCurrentUserId } from '../server';
import { createErrorResponse, createSuccessResponse } from './helpers';

const agenticUserService = Container.get(AgenticUserService);

/**
 * Register agent-related MCP tools
 * Includes both authenticated and unauthenticated tools
 */
export function registerAgentTools(server: McpServer) {
  // Register new agent - UNAUTHENTICATED
  // This tool does NOT require authentication
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'agent_register',
    {
      description:
        'Register a new AI agent user and receive API credentials. This tool does NOT require authentication. Use this if you do not have an API key yet. Returns: agentId (save this!), apiKey (save this - shown only once!), name, createdAt.',
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(100)
          .describe('A name for the agent (e.g., "Claude Finance Assistant")'),
      }),
    },
    async (params, _extra) => {
      try {
        const result = await agenticUserService.registerAgent({
          name: params.name,
        });

        return createSuccessResponse({
          message:
            'Agent registered successfully. IMPORTANT: Save your agentId and apiKey - the API key will not be shown again!',
          agentId: result.agentId,
          apiKey: result.apiKey,
          name: result.name,
          createdAt: result.createdAt.toISOString(),
          instructions: {
            authentication:
              'Include your API key in all future requests as: Authorization: Bearer <apiKey>',
            agentId:
              'Save your agentId - you may need it later to link your account to a regular user',
          },
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
export const UNAUTHENTICATED_TOOLS = ['agent_register'] as const;

/**
 * Check if a tool name is allowed without authentication
 */
export function isUnauthenticatedTool(toolName: string): boolean {
  return UNAUTHENTICATED_TOOLS.includes(toolName as (typeof UNAUTHENTICATED_TOOLS)[number]);
}
