import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WalletImplementations } from '@scani/core/features/implementations';
import { z } from 'zod';
import { getCurrentUserId } from '../server';
import { createErrorResponse, createSuccessResponse } from './helpers';

/**
 * Register wallet-related MCP tools
 * Maps to the wallet tRPC router
 */
export function registerWalletTools(server: McpServer) {
  // Get supported chains - no input
  server.registerTool(
    'wallet_getSupportedChains',
    {
      description: 'Get all supported blockchain chains',
    },
    async (_extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await WalletImplementations.getSupportedChains({ userId }, {});
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Import wallet address
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'wallet_importAddress',
    {
      description: 'Import a wallet address, detect chains, and create accounts/holdings',
      inputSchema: z.object({
        address: z.string().min(1).max(200).describe('Wallet address'),
        displayName: z.string().max(100).optional().describe('Display name for the wallet'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await WalletImplementations.importAddress({ userId }, params);
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Detect chains
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'wallet_detectChains',
    {
      description: 'Detect which blockchain chains a wallet address exists on',
      inputSchema: z.object({
        address: z.string().min(1).max(200).describe('Wallet address'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await WalletImplementations.detectChains({ userId }, params);
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
