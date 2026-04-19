/**
 * Integration authentication router
 * Handles credential validation and storage for exchange integrations
 */

import { db } from '@scani/core/database/connection';
import * as schema from '@scani/core/database/schema';
import { JOB_NAMES } from '@scani/core/queues';
import { ExpiredCredentialsError, IntegrationCredentialsService } from '@scani/core/services';
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
import { enqueueJob } from '../../queues/enqueue';
import { protectedProcedure, router } from '../trpc';

type TRPCErrorCode = ConstructorParameters<typeof TRPCError>[0]['code'];

/**
 * Map an arbitrary error thrown from a credential validation / import flow
 * into the closest-matching tRPC error code. Keeps TRPCError pass-through,
 * routes expired creds to UNAUTHORIZED, rate limits to TOO_MANY_REQUESTS,
 * timeouts to TIMEOUT, and 5xx / network errors to INTERNAL_SERVER_ERROR.
 * Anything else becomes the caller-provided fallback (usually BAD_REQUEST).
 */
function toTRPCError(
  error: unknown,
  context: { fallbackCode: TRPCErrorCode; fallbackMessage: string }
): TRPCError {
  if (error instanceof TRPCError) return error;

  if (error instanceof ExpiredCredentialsError) {
    return new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Integration credentials have expired — please reconnect',
      cause: error,
    });
  }

  const err = error as Error & { code?: string | number; status?: number };
  const status = typeof err?.status === 'number' ? err.status : undefined;
  const codeStr = typeof err?.code === 'string' ? err.code : undefined;
  const msg = err?.message?.toLowerCase() ?? '';

  if (status === 401 || status === 403 || msg.includes('unauthorized')) {
    return new TRPCError({
      code: 'UNAUTHORIZED',
      message: context.fallbackMessage,
      cause: error,
    });
  }
  if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests')) {
    return new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Upstream provider rate limit hit — try again shortly',
      cause: error,
    });
  }
  if (
    codeStr === 'ETIMEDOUT' ||
    codeStr === 'UND_ERR_CONNECT_TIMEOUT' ||
    msg.includes('timeout') ||
    msg.includes('timed out')
  ) {
    return new TRPCError({
      code: 'TIMEOUT',
      message: 'Upstream provider timed out',
      cause: error,
    });
  }
  if (
    (typeof status === 'number' && status >= 500) ||
    codeStr === 'ECONNRESET' ||
    codeStr === 'ECONNREFUSED' ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused')
  ) {
    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Upstream provider unavailable',
      cause: error,
    });
  }

  return new TRPCError({
    code: context.fallbackCode,
    message: context.fallbackMessage,
    cause: error,
  });
}

/**
 * Store credentials + enqueue import as a single guarded operation.
 *
 * The write to `user_integration_credentials` and the enqueue to BullMQ are
 * not naturally atomic (Postgres vs Redis). We bridge the gap via an
 * `import_status` column:
 *
 *   1. Store credentials with `import_status = 'pending_enqueue'`.
 *   2. Call `enqueueJob(...)`.
 *   3. On success, write `import_status = 'enqueued'` and stamp `import_job_id`.
 *   4. On enqueue failure, write `import_status = 'failed'` with the error
 *      message and rethrow — the reconciler scheduler will retry later.
 *
 * If the backend process dies between steps 1 and 2, the row remains in
 * `pending_enqueue` and the worker's reconciler (apps/worker/src/schedulers/
 * reconcile-pending-credentials.ts) sweeps it up within ~5 minutes.
 */
async function storeAndEnqueueImport(
  userId: string,
  institutionName: string,
  credentials: Record<string, string>,
  requestId: string
): Promise<{ institutionId: string; jobId: string }> {
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

  // 1. Store with pending_enqueue
  const stored = await credentialsService.storeCredentials(
    userId,
    institution.id,
    { ...credentials, storedAt: new Date().toISOString() },
    'api_key',
    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  );

  // 2. Enqueue; on failure, mark the row failed so UI surfaces actionable error.
  try {
    const jobId = await enqueueJob(JOB_NAMES.exchangeImport, {
      userId,
      requestId,
      institutionId: institution.id,
      provider: institutionName,
    });
    // 3. Promote to enqueued.
    await credentialsService.markImportEnqueued(stored.id, jobId);
    return { institutionId: institution.id, jobId };
  } catch (enqueueError) {
    await credentialsService.markImportFailed(
      stored.id,
      enqueueError instanceof Error ? enqueueError.message : String(enqueueError)
    );
    throw enqueueError;
  }
}

const apiKeyInput = z.object({
  apiKey: z.string().min(1, 'API Key is required'),
  apiSecret: z.string().min(1, 'API Secret is required'),
  requestId: z.string().uuid(),
});

/** Create router for exchanges with apiKey+apiSecret — validates, stores, and enqueues import. */
function createApiKeyOnlyRouter(
  name: string,
  validate: (k: string, s: string) => Promise<boolean>
) {
  return router({
    validateKeys: protectedProcedure.input(apiKeyInput).mutation(async ({ input, ctx }) => {
      const userId = ctx.userId;

      try {
        const isValid = await validate(input.apiKey, input.apiSecret);
        if (!isValid) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: `Invalid ${name} API credentials` });
        }
      } catch (error) {
        throw toTRPCError(error, {
          fallbackCode: 'BAD_REQUEST',
          fallbackMessage: `Failed to validate ${name} credentials`,
        });
      }

      try {
        const { institutionId, jobId } = await storeAndEnqueueImport(
          userId,
          name,
          { apiKey: input.apiKey, apiSecret: input.apiSecret },
          input.requestId
        );
        return {
          success: true,
          message: `${name} credentials validated and stored`,
          institutionId,
          jobId,
        };
      } catch (error) {
        throw toTRPCError(error, {
          fallbackCode: 'INTERNAL_SERVER_ERROR',
          fallbackMessage: 'Failed to store credentials and enqueue import',
        });
      }
    }),
  });
}

/** Create router for exchanges needing apiKey+apiSecret+passphrase — validates, stores, and enqueues import. */
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
          requestId: z.string().uuid(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.userId;

        try {
          const isValid = await validate(input.apiKey, input.apiSecret, input.passphrase);
          if (!isValid) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Invalid ${name} API credentials`,
            });
          }
        } catch (error) {
          throw toTRPCError(error, {
            fallbackCode: 'BAD_REQUEST',
            fallbackMessage: `Failed to validate ${name} credentials`,
          });
        }

        try {
          const { institutionId, jobId } = await storeAndEnqueueImport(
            userId,
            name,
            {
              apiKey: input.apiKey,
              apiSecret: input.apiSecret,
              passphrase: input.passphrase,
            },
            input.requestId
          );
          return {
            success: true,
            message: `${name} credentials validated and stored`,
            institutionId,
            jobId,
          };
        } catch (error) {
          throw toTRPCError(error, {
            fallbackCode: 'INTERNAL_SERVER_ERROR',
            fallbackMessage: 'Failed to store credentials and enqueue import',
          });
        }
      }),
  });
}

export const integrationsRouter = router({
  // All crypto exchanges: validate credentials, store, and auto-import immediately
  binance: createApiKeyOnlyRouter('Binance', validateBinanceCredentials),
  kraken: createApiKeyOnlyRouter('Kraken', validateKrakenCredentials),
  bybit: createApiKeyOnlyRouter('Bybit', validateBybitCredentials),
  coinbase: createApiKeyOnlyRouter('Coinbase', validateCoinbaseCredentials),
  bitstamp: createApiKeyOnlyRouter('Bitstamp', validateBitstampCredentials),
  gemini: createApiKeyOnlyRouter('Gemini', validateGeminiCredentials),
  mexc: createApiKeyOnlyRouter('MEXC', validateMexcCredentials),
  gateio: createApiKeyOnlyRouter('Gate.io', validateGateioCredentials),
  huobi: createApiKeyOnlyRouter('Huobi', validateHuobiCredentials),

  okx: createPassphraseRouter('OKX', validateOkxCredentials),
  kucoin: createPassphraseRouter('KuCoin', validateKucoinCredentials),
  bitget: createPassphraseRouter('Bitget', validateBitgetCredentials),

  // Wise uses a single API token
  wise: router({
    validateKeys: protectedProcedure
      .input(
        z.object({
          apiToken: z.string().min(1, 'API Token is required'),
          requestId: z.string().uuid(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        try {
          const isValid = await validateWiseCredentials(input.apiToken);
          if (!isValid) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid Wise API token' });
          }
        } catch (error) {
          throw toTRPCError(error, {
            fallbackCode: 'BAD_REQUEST',
            fallbackMessage: 'Failed to validate Wise credentials',
          });
        }

        try {
          const { institutionId, jobId } = await storeAndEnqueueImport(
            ctx.userId,
            'Wise',
            { apiToken: input.apiToken },
            input.requestId
          );
          return {
            success: true,
            message: 'Wise credentials validated and stored',
            institutionId,
            jobId,
          };
        } catch (error) {
          throw toTRPCError(error, {
            fallbackCode: 'INTERNAL_SERVER_ERROR',
            fallbackMessage: 'Failed to store credentials',
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
          requestId: z.string().uuid(),
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
          throw toTRPCError(error, {
            fallbackCode: 'BAD_REQUEST',
            fallbackMessage: 'Failed to validate IBKR credentials',
          });
        }

        try {
          const { institutionId, jobId } = await storeAndEnqueueImport(
            ctx.userId,
            'Interactive Brokers',
            { token: input.token, queryId: input.queryId },
            input.requestId
          );
          return {
            success: true,
            message: 'Interactive Brokers credentials validated and stored',
            institutionId,
            jobId,
          };
        } catch (error) {
          throw toTRPCError(error, {
            fallbackCode: 'INTERNAL_SERVER_ERROR',
            fallbackMessage: 'Failed to store credentials and enqueue import',
          });
        }
      }),
  }),
});
