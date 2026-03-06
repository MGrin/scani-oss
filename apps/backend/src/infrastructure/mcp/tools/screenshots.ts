import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ParseScreenshotUseCase } from '@scani/core/use-cases/ParseScreenshotUseCase';
import { Container } from 'typedi';
import { z } from 'zod';
import { getCurrentUserId } from '../server';
import { createErrorResponse, createSuccessResponse } from './helpers';

/**
 * Register screenshot-parsing MCP tools
 * Maps to the screenshots tRPC router
 *
 * This tool lets agents upload base64-encoded portfolio screenshots and receive
 * a structured list of holdings extracted by AI, ready for holdings_create.
 * Cost: $0.15 USDC per call (AI parsing is compute-intensive).
 */
export function registerScreenshotsTools(server: McpServer) {
  const parseScreenshotUseCase = Container.get(ParseScreenshotUseCase);

  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'screenshots_parse',
    {
      description:
        'Parse a portfolio screenshot using AI and extract a list of holdings (token symbol, balance). ' +
        'Accepts a single base64-encoded image. Returns holdings with optional token IDs for use with holdings_create. ' +
        'Costs $0.15 USDC per call.',
      inputSchema: z.object({
        imageBase64: z
          .string()
          .min(1)
          .describe('Base64-encoded image data (PNG, JPG, JPEG, GIF or WebP)'),
        filename: z
          .string()
          .min(1)
          .describe('Original filename including extension, e.g. "portfolio.png"'),
        accountId: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Optional account ID to check for already-existing holdings (enriches response with existingBalance)'
          ),
        accountType: z
          .string()
          .optional()
          .describe('Optional hint about account type, e.g. "crypto", "stock"'),
        expectedCurrency: z
          .string()
          .optional()
          .describe('Optional hint about the primary currency shown, e.g. "USD"'),
        context: z
          .string()
          .optional()
          .describe('Optional additional context to help the AI, e.g. "Binance spot wallet"'),
        minConfidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Minimum confidence threshold for returned holdings (0–1, default 0.5)'),
        provider: z
          .enum(['openai', 'perplexity', 'deepseek'])
          .optional()
          .describe('AI provider to use for parsing (default: openai)'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();

        const result = await parseScreenshotUseCase.execute({
          imageBase64: params.imageBase64,
          provider: params.provider,
          accountType: params.accountType,
          expectedCurrency: params.expectedCurrency,
          context: params.context,
          minConfidence: params.minConfidence ?? 0.5,
          accountId: params.accountId,
          userId,
        });

        return createSuccessResponse({
          holdings: result.holdings,
          overallConfidence: result.overallConfidence,
          context: result.context,
          detectedCurrency: result.detectedCurrency,
          // Convenience summary
          summary: {
            totalHoldings: result.holdings.length,
            holdingsWithTokenId: result.holdings.filter((h) => h.tokenId).length,
            holdingsWithExistingBalance: result.holdings.filter((h) => h.holdingId).length,
          },
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
