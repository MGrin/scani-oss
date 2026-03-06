import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InstitutionImplementations } from '@scani/core/features/implementations';
import { CreateInstitutionDto } from '@scani/shared';
import ogs from 'open-graph-scraper';
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
  // Create institution
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'institutions_create',
    {
      description:
        'Create a custom institution (bank, exchange, broker, etc.). Use institutionTypes_getAll to get valid typeId values.',
      inputSchema: z.object({
        name: z.string().min(1).max(200).describe('Institution name'),
        typeId: z.string().uuid().describe('Institution type ID (from institutionTypes_getAll)'),
        description: z.string().max(500).optional().describe('Optional description'),
        website: z.string().url().optional().describe('Institution website URL'),
        logoUrl: z.string().url().optional().describe('Logo image URL'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();
        const validatedInput = CreateInstitutionDto.parse(params);
        const result = await InstitutionImplementations.create({ userId }, validatedInput);
        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Get all institutions - no input
  server.registerTool(
    'institutions_getAll',
    {
      description: 'Get all available institutions (system-wide catalogue)',
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

  // Get user's own institutions
  server.registerTool(
    'institutions_getByUserId',
    {
      description: 'Get institutions that have at least one account belonging to the current user',
    },
    async (_extra) => {
      try {
        const userId = getCurrentUserId();
        const result = await InstitutionImplementations.getByUserId({ userId }, {});
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

  // Fetch Open Graph metadata from a website URL to pre-populate institution fields
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'institutions_getOpenGraphMetadata',
    {
      description:
        'Fetch Open Graph metadata from a website URL to auto-populate institution name, description and logo. Call this before institutions_create when you have a website URL.',
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .describe('Website URL of the institution (e.g. https://coinbase.com)'),
      }),
    },
    async (params, _extra) => {
      try {
        getCurrentUserId(); // ensure authenticated
        const { result: ogResult } = await ogs({ url: params.url });
        const data = {
          title: ogResult.ogTitle ?? ogResult.twitterTitle ?? ogResult.dcTitle ?? '',
          description:
            ogResult.ogDescription ?? ogResult.twitterDescription ?? ogResult.dcDescription ?? '',
          siteName: ogResult.ogSiteName ?? '',
          image: ogResult.ogImage?.[0]?.url ?? ogResult.twitterImage?.[0]?.url ?? '',
          type: ogResult.ogType ?? '',
        };
        return createSuccessResponse(data);
      } catch {
        // Return empty metadata instead of throwing (network might be unreachable)
        return createSuccessResponse({
          title: '',
          description: '',
          siteName: '',
          image: '',
          type: '',
        });
      }
    }
  );
}
