/**
 * Integration authentication router
 * Handles credential validation and storage for exchange integrations
 */

import { db } from '@scani/core/database/connection';
import * as schema from '@scani/core/database/schema';
import { IntegrationCredentialsService } from '@scani/core/services';
import {
  ImportBinanceAccountsUseCase,
  ImportIbkrAccountsUseCase,
  ImportKrakenAccountsUseCase,
} from '@scani/core/use-cases';
import {
  validateBinanceCredentials,
  validateBitgetCredentials,
  validateBitstampCredentials,
  validateBybitCredentials,
  validateCoinbaseCredentials,
  validateGateioCredentials,
  validateGeminiCredentials,
  validateHuobiCredentials,
  validateIbkrCredentials,
  validateKrakenCredentials,
  validateKucoinCredentials,
  validateMexcCredentials,
  validateOkxCredentials,
  validateWiseCredentials,
} from '@scani/integrations';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';

interface ExchangeImportResult {
  accounts: Array<{ id: string; name: string; accountType: string }>;
  holdings: Array<{ id: string; accountId: string; tokenSymbol: string; balance: string }>;
  accountsCreated: number;
  tokensImported: number;
  errors: Array<{ accountType: string; error: string }>;
}

/** Config for exchanges with apiKey + apiSecret that support auto-import */
interface ExchangeWithImportConfig {
  name: string;
  validateCredentials: (apiKey: string, apiSecret: string) => Promise<boolean>;
  getImportUseCase: () => {
    execute: (params: { userId: string; institutionId: string }) => Promise<ExchangeImportResult>;
  };
}

const EXCHANGES_WITH_IMPORT: Record<string, ExchangeWithImportConfig> = {
  binance: {
    name: 'Binance',
    validateCredentials: validateBinanceCredentials,
    getImportUseCase: () => Container.get(ImportBinanceAccountsUseCase),
  },
  kraken: {
    name: 'Kraken',
    validateCredentials: validateKrakenCredentials,
    getImportUseCase: () => Container.get(ImportKrakenAccountsUseCase),
  },
};

const apiKeyInput = z.object({
  apiKey: z.string().min(1, 'API Key is required'),
  apiSecret: z.string().min(1, 'API Secret is required'),
});

/** Helper: look up institution by name and store credentials */
async function storeExchangeCredentials(
  userId: string,
  institutionName: string,
  credentials: Record<string, string>
) {
  const credentialsService = Container.get(IntegrationCredentialsService);

  const [institution] = await db
    .select()
    .from(schema.institutions)
    .where(eq(schema.institutions.name, institutionName))
    .limit(1);

  if (!institution) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `${institutionName} institution not found in database. Please run migrations.`,
    });
  }

  await credentialsService.storeCredentials(
    userId,
    institution.id,
    { ...credentials, storedAt: new Date().toISOString() },
    'api_key',
    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  );

  return institution.id;
}

/** Create router for exchanges with apiKey+apiSecret and auto-import */
function createExchangeWithImportRouter(config: ExchangeWithImportConfig) {
  return router({
    validateKeys: protectedProcedure.input(apiKeyInput).mutation(async ({ input, ctx }) => {
      const { apiKey, apiSecret } = input;
      const userId = ctx.userId;

      try {
        const isValid = await config.validateCredentials(apiKey, apiSecret);
        if (!isValid) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Invalid ${config.name} API Key or Secret`,
          });
        }
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Failed to validate ${config.name} credentials`,
          cause: error,
        });
      }

      try {
        const institutionId = await storeExchangeCredentials(userId, config.name, {
          apiKey,
          apiSecret,
        });

        const importUseCase = config.getImportUseCase();
        const importResult = await importUseCase.execute({ userId, institutionId });

        return {
          success: true,
          message: `${config.name} credentials validated and stored`,
          institutionId,
          accounts: importResult.accounts,
          holdings: importResult.holdings,
          accountsCreated: importResult.accountsCreated,
          tokensImported: importResult.tokensImported,
          errors: importResult.errors,
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to store credentials and import accounts',
          cause: error,
        });
      }
    }),
  });
}

/** Create router for exchanges with apiKey+apiSecret (validate + store only, no auto-import) */
function createApiKeyOnlyRouter(
  name: string,
  validate: (k: string, s: string) => Promise<boolean>
) {
  return router({
    validateKeys: protectedProcedure.input(apiKeyInput).mutation(async ({ input, ctx }) => {
      try {
        const isValid = await validate(input.apiKey, input.apiSecret);
        if (!isValid) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: `Invalid ${name} API credentials` });
        }
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Failed to validate ${name} credentials`,
          cause: error,
        });
      }

      try {
        const institutionId = await storeExchangeCredentials(ctx.userId, name, {
          apiKey: input.apiKey,
          apiSecret: input.apiSecret,
        });
        return {
          success: true,
          message: `${name} credentials validated and stored`,
          institutionId,
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to store credentials',
          cause: error,
        });
      }
    }),
  });
}

/** Create router for exchanges needing apiKey+apiSecret+passphrase */
function createPassphraseRouter(
  name: string,
  validate: (k: string, s: string, p: string) => Promise<boolean>
) {
  return router({
    validateKeys: protectedProcedure
      .input(
        z.object({
          apiKey: z.string().min(1, 'API Key is required'),
          apiSecret: z.string().min(1, 'API Secret is required'),
          passphrase: z.string().min(1, 'Passphrase is required'),
        })
      )
      .mutation(async ({ input, ctx }) => {
        try {
          const isValid = await validate(input.apiKey, input.apiSecret, input.passphrase);
          if (!isValid) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Invalid ${name} API credentials`,
            });
          }
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Failed to validate ${name} credentials`,
            cause: error,
          });
        }

        try {
          const institutionId = await storeExchangeCredentials(ctx.userId, name, {
            apiKey: input.apiKey,
            apiSecret: input.apiSecret,
            passphrase: input.passphrase,
          });
          return {
            success: true,
            message: `${name} credentials validated and stored`,
            institutionId,
          };
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to store credentials',
            cause: error,
          });
        }
      }),
  });
}

export const integrationsRouter = router({
  // Exchanges with full auto-import (Binance/Kraken have dedicated use cases)
  binance: createExchangeWithImportRouter(EXCHANGES_WITH_IMPORT.binance!),
  kraken: createExchangeWithImportRouter(EXCHANGES_WITH_IMPORT.kraken!),

  // Exchanges with apiKey + apiSecret (validate + store, sync via cron)
  bybit: createApiKeyOnlyRouter('Bybit', validateBybitCredentials),
  coinbase: createApiKeyOnlyRouter('Coinbase', validateCoinbaseCredentials),
  bitstamp: createApiKeyOnlyRouter('Bitstamp', validateBitstampCredentials),
  gemini: createApiKeyOnlyRouter('Gemini', validateGeminiCredentials),
  mexc: createApiKeyOnlyRouter('MEXC', validateMexcCredentials),
  gateio: createApiKeyOnlyRouter('Gate.io', validateGateioCredentials),
  huobi: createApiKeyOnlyRouter('Huobi', validateHuobiCredentials),

  // Exchanges needing apiKey + apiSecret + passphrase
  okx: createPassphraseRouter('OKX', validateOkxCredentials),
  kucoin: createPassphraseRouter('KuCoin', validateKucoinCredentials),
  bitget: createPassphraseRouter('Bitget', validateBitgetCredentials),

  // Wise uses a single API token
  wise: router({
    validateKeys: protectedProcedure
      .input(z.object({ apiToken: z.string().min(1, 'API Token is required') }))
      .mutation(async ({ input, ctx }) => {
        try {
          const isValid = await validateWiseCredentials(input.apiToken);
          if (!isValid) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid Wise API token' });
          }
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Failed to validate Wise credentials',
            cause: error,
          });
        }

        try {
          const institutionId = await storeExchangeCredentials(ctx.userId, 'Wise', {
            apiToken: input.apiToken,
          });
          return { success: true, message: 'Wise credentials validated and stored', institutionId };
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to store credentials',
            cause: error,
          });
        }
      }),
  }),

  // IBKR uses Flex Query token + query ID
  ibkr: router({
    validateKeys: protectedProcedure
      .input(
        z.object({
          token: z.string().min(1, 'Flex Web Service Token is required'),
          queryId: z.string().min(1, 'Flex Query ID is required'),
        })
      )
      .mutation(async ({ input, ctx }) => {
        try {
          const isValid = await validateIbkrCredentials(input.token, input.queryId);
          if (!isValid) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Invalid IBKR Flex Query credentials',
            });
          }
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Failed to validate IBKR credentials',
            cause: error,
          });
        }

        try {
          const institutionId = await storeExchangeCredentials(ctx.userId, 'Interactive Brokers', {
            token: input.token,
            queryId: input.queryId,
          });

          const importUseCase = Container.get(ImportIbkrAccountsUseCase);
          const importResult = await importUseCase.execute({
            userId: ctx.userId,
            institutionId,
          });

          return {
            success: true,
            message: 'Interactive Brokers credentials validated and stored',
            institutionId,
            accounts: importResult.accounts,
            holdings: importResult.holdings,
            accountsCreated: importResult.accountsCreated,
            tokensImported: importResult.tokensImported,
            errors: importResult.errors,
          };
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to store credentials and import accounts',
            cause: error,
          });
        }
      }),
  }),
});
