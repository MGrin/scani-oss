/**
 * Integration authentication router
 * Handles credential validation and storage for exchange integrations
 */

import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { IntegrationCredentialsService } from '@scani/domain/services';
import {
  validateAlpacaCredentials,
  validateBinanceCredentials,
  validateBitbankCredentials,
  validateBitfinexCredentials,
  validateBitflyerCredentials,
  validateBitgetCredentials,
  validateBitpandaCredentials,
  validateBitstampCredentials,
  validateBrexCredentials,
  validateBtcMarketsCredentials,
  validateBybitCredentials,
  validateCoinbaseCredentials,
  validateCoincheckCredentials,
  validateGateioCredentials,
  validateGeminiCredentials,
  validateHuobiCredentials,
  validateIndependentReserveCredentials,
  validateKrakenCredentials,
  validateKucoinCredentials,
  validateMercuryCredentials,
  validateMexcCredentials,
  validateOkxCredentials,
  validateTigerCredentials,
  validateTinkoffCredentials,
  validateWiseCredentials,
  validateZerodhaCredentials,
} from '@scani/integrations';
import { JOB_NAMES } from '@scani/queue';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { z } from 'zod';
import { enqueueJob } from '../../queues/enqueue';
import { toTRPCError } from '../../utils/error-mapping';
import { protectedProcedure, router } from '../trpc';

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

const passphraseInput = apiKeyInput.extend({
  passphrase: z.string().min(1, 'Passphrase is required'),
});

/**
 * Generic exchange-credentials router factory.
 *
 * Consolidates the previous `createApiKeyOnlyRouter` and
 * `createPassphraseRouter` (which shared identical structure — validate →
 * store → enqueue → return — and only differed by the input schema + the
 * arity of the validator fn). Parameterised on:
 *
 *   - `input`: zod schema the procedure parses.
 *   - `extractCredentials`: pulls the credential fields off the parsed input
 *     so the stored blob has only the fields that validate used.
 *   - `validate`: the provider's validator, called with the same fields.
 *
 * All exchange routers below go through this one factory.
 */
interface ParsedCredentialInput {
  requestId: string;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
}

function createCredentialsRouter<TCreds extends Record<string, string>>(opts: {
  name: string;
  input: z.ZodTypeAny;
  extractCredentials: (parsed: ParsedCredentialInput) => TCreds;
  validate: (creds: TCreds) => Promise<boolean>;
}) {
  const { name, input, extractCredentials, validate } = opts;
  return router({
    validateKeys: protectedProcedure.input(input).mutation(async ({ input: rawInput, ctx }) => {
      const parsed = rawInput as ParsedCredentialInput;
      const userId = ctx.userId;
      const credentials = extractCredentials(parsed);

      try {
        const isValid = await validate(credentials);
        if (!isValid) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Invalid ${name} API credentials`,
          });
        }
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        // Preserve the upstream provider's message (e.g. Kraken's
        // "EAPI:Invalid signature") so the UI shows the actual cause
        // rather than a generic "Failed to validate" wrapper.
        const upstream = error instanceof Error && error.message ? error.message : String(error);
        throw toTRPCError(error, {
          fallbackCode: 'BAD_REQUEST',
          fallbackMessage: `${name}: ${upstream}`,
        });
      }

      try {
        const { institutionId, jobId } = await storeAndEnqueueImport(
          userId,
          name,
          credentials,
          parsed.requestId
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

/** Thin presets over `createCredentialsRouter` for the two schema shapes
 * used by every exchange in this repo. Callers pass just the provider
 * name + their validator — no more copy-pasted boilerplate per exchange. */
function createApiKeyOnlyRouter(
  name: string,
  validate: (k: string, s: string) => Promise<boolean>
) {
  return createCredentialsRouter({
    name,
    input: apiKeyInput,
    extractCredentials: (p) => ({ apiKey: p.apiKey, apiSecret: p.apiSecret }),
    validate: (c) => validate(c.apiKey, c.apiSecret),
  });
}

function createPassphraseRouter(
  name: string,
  validate: (k: string, s: string, p: string) => Promise<boolean>
) {
  return createCredentialsRouter({
    name,
    input: passphraseInput,
    extractCredentials: (p) => ({
      apiKey: p.apiKey,
      apiSecret: p.apiSecret,
      passphrase: p.passphrase ?? '',
    }),
    validate: (c) => validate(c.apiKey, c.apiSecret, c.passphrase),
  });
}

/**
 * Single-token providers (Bitpanda, Tinkoff, Mercury, Brex). The token
 * lands in the stored credential blob as `apiToken`, which every
 * corresponding integration reads from that slot.
 */
function createTokenRouter(name: string, validate: (token: string) => Promise<boolean>) {
  const tokenInput = z.object({
    apiToken: z.string().min(1, 'API Token is required'),
    requestId: z.string().uuid(),
  });
  return router({
    validateKeys: protectedProcedure.input(tokenInput).mutation(async ({ input, ctx }) => {
      try {
        const isValid = await validate(input.apiToken);
        if (!isValid) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Invalid ${name} API token`,
          });
        }
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        const upstream = error instanceof Error && error.message ? error.message : String(error);
        throw toTRPCError(error, {
          fallbackCode: 'BAD_REQUEST',
          fallbackMessage: `${name}: ${upstream}`,
        });
      }

      try {
        const { institutionId, jobId } = await storeAndEnqueueImport(
          ctx.userId,
          name,
          { apiToken: input.apiToken },
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
  independent_reserve: createApiKeyOnlyRouter(
    'Independent Reserve',
    validateIndependentReserveCredentials
  ),
  btc_markets: createApiKeyOnlyRouter('BTC Markets', validateBtcMarketsCredentials),
  bitfinex: createApiKeyOnlyRouter('Bitfinex', validateBitfinexCredentials),
  bitflyer: createApiKeyOnlyRouter('bitFlyer', validateBitflyerCredentials),
  coincheck: createApiKeyOnlyRouter('Coincheck', validateCoincheckCredentials),
  bitbank: createApiKeyOnlyRouter('bitbank', validateBitbankCredentials),
  alpaca: createApiKeyOnlyRouter('Alpaca', validateAlpacaCredentials),
  tiger_brokers: createApiKeyOnlyRouter('Tiger Brokers', validateTigerCredentials),

  // Kite Connect: we auto-refresh the access_token from the user's
  // Kite client ID + password + TOTP secret every sync. That's more
  // credential surface than a typical integration, but it's what it
  // takes to cover Kite's once-a-day token expiry without pestering
  // users to re-auth daily.
  zerodha: router({
    validateKeys: protectedProcedure
      .input(
        z.object({
          apiKey: z.string().min(1, 'Kite api_key is required'),
          apiSecret: z.string().min(1, 'Kite api_secret is required'),
          userId: z.string().min(1, 'Kite user_id is required'),
          password: z.string().min(1, 'Kite password is required'),
          totpSecret: z.string().min(1, 'TOTP secret is required'),
          requestId: z.string().uuid(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const creds = {
          apiKey: input.apiKey,
          apiSecret: input.apiSecret,
          userId: input.userId,
          password: input.password,
          totpSecret: input.totpSecret,
        };
        try {
          const isValid = await validateZerodhaCredentials(creds);
          if (!isValid) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Invalid Zerodha credentials — check user_id, password, and TOTP secret',
            });
          }
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          const upstream = error instanceof Error && error.message ? error.message : String(error);
          throw toTRPCError(error, {
            fallbackCode: 'BAD_REQUEST',
            fallbackMessage: `Zerodha: ${upstream}`,
          });
        }

        try {
          const { institutionId, jobId } = await storeAndEnqueueImport(
            ctx.userId,
            'Zerodha',
            creds,
            input.requestId
          );
          return {
            success: true,
            message: 'Zerodha credentials validated and stored',
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

  // Single-token providers
  bitpanda: createTokenRouter('Bitpanda', validateBitpandaCredentials),
  tinkoff: createTokenRouter('T-Bank (Tinkoff)', validateTinkoffCredentials),
  mercury: createTokenRouter('Mercury', validateMercuryCredentials),
  brex: createTokenRouter('Brex', validateBrexCredentials),

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
        // NOTE: we do NOT pre-validate the token here. IBKR's Flex Web
        // Service rejects a second SendRequest on the same token within a
        // short window (error 1018 "Too many requests have been made from
        // this token"). If we validate at the router *and* the worker
        // fetches the report, that's two SendRequests within seconds of
        // each other — the second trips 1018 on every connect attempt.
        // Defer validation to the worker: it makes exactly one Flex call
        // and surfaces the real error (invalid token, expired, rate
        // limited, etc.) on the job page. The redirect → job page flow
        // gives the user the same visibility as a router-level error.
        try {
          const { institutionId, jobId } = await storeAndEnqueueImport(
            ctx.userId,
            'Interactive Brokers',
            { token: input.token, queryId: input.queryId },
            input.requestId
          );
          return {
            success: true,
            message: 'Interactive Brokers credentials stored — running import',
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
