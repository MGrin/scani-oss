/**
 * Integration authentication router
 * Handles credential validation and storage for integrations
 */

import { db } from '@scani/core/database/connection';
import * as schema from '@scani/core/database/schema';
import { IntegrationCredentialsService } from '@scani/core/services';
import { ImportBinanceAccountsUseCase } from '@scani/core/use-cases';
import { validateBinanceCredentials } from '@scani/integrations';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';

/**
 * Integration authentication router
 */
export const integrationsRouter = router({
  /**
   * Validate and store Binance API credentials
   */
  binance: router({
    validateKeys: protectedProcedure
      .input(
        z.object({
          apiKey: z.string().min(1, 'API Key is required'),
          apiSecret: z.string().min(1, 'API Secret is required'),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { apiKey, apiSecret } = input;
        const userId = ctx.user.id;

        // Validate keys using the factory function from integrations package
        let isValid: boolean;
        try {
          isValid = await validateBinanceCredentials(apiKey, apiSecret);
          if (!isValid) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Invalid Binance API Key or Secret',
            });
          }
        } catch (error) {
          if (error instanceof TRPCError) {
            throw error;
          }
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Failed to validate Binance credentials',
            cause: error,
          });
        }

        // Store credentials
        try {
          const credentialsService = Container.get(IntegrationCredentialsService);

          // Look up Binance institution from database
          const binanceInstitution = await db
            .select()
            .from(schema.institutions)
            .where(eq(schema.institutions.name, 'Binance'))
            .limit(1);

          if (binanceInstitution.length === 0) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Binance institution not found in database. Please run migrations.',
            });
          }

          const binanceInstitutionId = binanceInstitution[0]!.id;

          const credentials = {
            apiKey,
            apiSecret,
            // API keys don't expire, but set a long expiration for consistency
            storedAt: new Date().toISOString(),
          };

          // Store with never-expiring date (or very far in future)
          await credentialsService.storeCredentials(
            userId,
            binanceInstitutionId,
            credentials,
            'api_key',
            new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 year
          );

          // Automatically import accounts and holdings
          const importBinanceAccountsUseCase = Container.get(ImportBinanceAccountsUseCase);
          const importResult = await importBinanceAccountsUseCase.execute({
            userId,
            institutionId: binanceInstitutionId,
          });

          return {
            success: true,
            message: 'Binance credentials validated and stored',
            accounts: importResult.accounts,
            holdings: importResult.holdings,
            accountsCreated: importResult.accountsCreated,
            tokensImported: importResult.tokensImported,
            errors: importResult.errors,
          };
        } catch (error) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to store credentials and import accounts',
            cause: error,
          });
        }
      }),
  }),
});
