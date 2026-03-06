import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '@scani/core/database/connection';
import * as schema from '@scani/core/database/schema';
import { IntegrationCredentialsService } from '@scani/core/services';
import { ImportBinanceAccountsUseCase, ImportKrakenAccountsUseCase } from '@scani/core/use-cases';
import { validateBinanceCredentials, validateKrakenCredentials } from '@scani/integrations';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { z } from 'zod';
import { getCurrentUserId } from '../server';
import { createErrorResponse, createSuccessResponse } from './helpers';

/** Credential expiry: 1 year from storage date */
const CREDENTIAL_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Register exchange-integration MCP tools
 * Maps to the integrations tRPC router
 *
 * These tools let agents connect Binance / Kraken accounts on behalf of users,
 * automatically importing accounts and holdings after credential validation.
 */
export function registerIntegrationsTools(server: McpServer) {
  // Binance integration setup
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'integrations_binance_validateKeys',
    {
      description:
        "Validate Binance API credentials and import the user's Binance accounts and holdings into Scani. Requires a Binance Read-Only API key.",
      inputSchema: z.object({
        apiKey: z.string().min(1).describe('Binance API Key'),
        apiSecret: z.string().min(1).describe('Binance API Secret'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();

        // Validate credentials
        let isValid: boolean;
        try {
          isValid = await validateBinanceCredentials(params.apiKey, params.apiSecret);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to validate Binance credentials: ${msg}`);
        }

        if (!isValid) {
          throw new Error('Invalid Binance API Key or Secret');
        }

        // Look up Binance institution
        const binanceRows = await db
          .select()
          .from(schema.institutions)
          .where(eq(schema.institutions.name, 'Binance'))
          .limit(1);

        if (binanceRows.length === 0) {
          throw new Error('Binance institution not found. Please run database migrations.');
        }

        const binanceInstitutionId = binanceRows[0]!.id;

        // Store credentials
        const credentialsService = Container.get(IntegrationCredentialsService);
        await credentialsService.storeCredentials(
          userId,
          binanceInstitutionId,
          {
            apiKey: params.apiKey,
            apiSecret: params.apiSecret,
            storedAt: new Date().toISOString(),
          },
          'api_key',
          new Date(Date.now() + CREDENTIAL_EXPIRY_MS)
        );

        // Import accounts and holdings
        const importUseCase = Container.get(ImportBinanceAccountsUseCase);
        const importResult = await importUseCase.execute({
          userId,
          institutionId: binanceInstitutionId,
        });

        return createSuccessResponse({
          success: true,
          message: 'Binance credentials validated and accounts imported',
          accounts: importResult.accounts,
          holdings: importResult.holdings,
          accountsCreated: importResult.accountsCreated,
          tokensImported: importResult.tokensImported,
          errors: importResult.errors,
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // Kraken integration setup
  // @ts-expect-error - MCP SDK type inference is excessively deep
  server.registerTool(
    'integrations_kraken_validateKeys',
    {
      description:
        "Validate Kraken API credentials and import the user's Kraken accounts and holdings into Scani. Requires a Kraken API key with Query Funds permission.",
      inputSchema: z.object({
        apiKey: z.string().min(1).describe('Kraken API Key'),
        apiSecret: z.string().min(1).describe('Kraken API Secret (private key)'),
      }),
    },
    async (params, _extra) => {
      try {
        const userId = getCurrentUserId();

        // Validate credentials
        let isValid: boolean;
        try {
          isValid = await validateKrakenCredentials(params.apiKey, params.apiSecret);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to validate Kraken credentials: ${msg}`);
        }

        if (!isValid) {
          throw new Error('Invalid Kraken API Key or Secret');
        }

        // Look up Kraken institution
        const krakenRows = await db
          .select()
          .from(schema.institutions)
          .where(eq(schema.institutions.name, 'Kraken'))
          .limit(1);

        if (krakenRows.length === 0) {
          throw new Error('Kraken institution not found. Please run database migrations.');
        }

        const krakenInstitutionId = krakenRows[0]!.id;

        // Store credentials
        const credentialsService = Container.get(IntegrationCredentialsService);
        await credentialsService.storeCredentials(
          userId,
          krakenInstitutionId,
          {
            apiKey: params.apiKey,
            apiSecret: params.apiSecret,
            storedAt: new Date().toISOString(),
          },
          'api_key',
          new Date(Date.now() + CREDENTIAL_EXPIRY_MS)
        );

        // Import accounts and holdings
        const importUseCase = Container.get(ImportKrakenAccountsUseCase);
        const importResult = await importUseCase.execute({
          userId,
          institutionId: krakenInstitutionId,
        });

        return createSuccessResponse({
          success: true,
          message: 'Kraken credentials validated and accounts imported',
          accounts: importResult.accounts,
          holdings: importResult.holdings,
          accountsCreated: importResult.accountsCreated,
          tokensImported: importResult.tokensImported,
          errors: importResult.errors,
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
