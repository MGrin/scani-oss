/**
 * Integration authentication router.
 *
 * Two endpoints back the entire credentialed-integration flow:
 *
 *   - `listAvailable` — enumerates every credentialed provider in the
 *     `ProviderRegistry`. Each entry joins the provider's `IntegrationManifest`
 *     (form schema + setup instructions) with its `institutions` row
 *     (display name, description, website, logo, type). The frontend
 *     renders the integrations grid + setup dialog directly off this list,
 *     so adding a new provider needs zero frontend changes.
 *
 *   - `validateKeys` — single generic mutation that takes a `providerKey` +
 *     a credentials map, validates the payload against the manifest's
 *     `credentialFields`, dispatches to `CredentialValidator` (skipped for
 *     manifests with `skipServerValidation: true`, e.g. IBKR — where the
 *     worker validates), and enqueues the EXCHANGE_IMPORT job.
 */

import { ANALYTICS_EVENTS, AnalyticsService } from '@scani/analytics';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { IntegrationCredentialsService } from '@scani/domain/services';
import { EXCHANGE_IMPORT } from '@scani/jobs';
import type { IntegrationManifest } from '@scani/providers/core';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { BullMqEnqueueService } from '@scani/queue';
import { createOutflowLimiter, getSharedRedis } from '@scani/rate-limiter';
import { TRPCError } from '@trpc/server';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { z } from 'zod';
import { toTRPCError } from '../../utils/error-mapping';
import { protectedProcedure, router } from '../trpc';

// Per-user rate budget for `validateKeys`. The global tRPC limiter (60/min)
// is too generous for this endpoint — each call performs upstream HTTP
// validation against the exchange's API and CPU work decrypting the
// payload. 5 attempts/min/user is plenty for legitimate retries while
// preventing a stuck client (or hostile actor) from saturating CPU and
// burning the exchange's per-key quota with junk credentials.
const validateKeysLimiter = createOutflowLimiter({
  maxRequests: 5,
  windowMs: 60_000,
  redis: getSharedRedis(),
  namespace: 'inflow:validate-keys',
});

/**
 * Store credentials + enqueue import as a single guarded operation.
 *
 * The write to `user_integration_credentials` and the enqueue to BullMQ are
 * not naturally atomic (Postgres vs Redis). We bridge the gap via an
 * `import_status` column:
 *
 *   1. Store credentials with `import_status = 'pending_enqueue'`.
 *   2. Call `EnqueueService.add(...)`.
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

  const stored = await credentialsService.storeCredentials(
    userId,
    institution.id,
    { ...credentials, storedAt: new Date().toISOString() },
    'api_key',
    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  );

  try {
    const jobId = await Container.get(BullMqEnqueueService).add(EXCHANGE_IMPORT, {
      userId,
      requestId,
      institutionId: institution.id,
      provider: institutionName,
    });
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

/**
 * Validate the submitted credentials map matches the manifest's declared
 * `credentialFields`. Required fields must be non-empty; unknown fields
 * are rejected to prevent the frontend from smuggling in extra blob keys.
 */
function assertCredentialsMatchManifest(
  manifest: IntegrationManifest,
  credentials: Record<string, string>
): void {
  const declared = new Set(manifest.credentialFields.map((f) => f.name));
  for (const key of Object.keys(credentials)) {
    if (!declared.has(key)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Unknown credential field: ${key}`,
      });
    }
  }
  for (const field of manifest.credentialFields) {
    if (!field.required) continue;
    const value = credentials[field.name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `${field.label} is required`,
      });
    }
  }
}

export const integrationsRouter = router({
  /**
   * Enumerates every credentialed provider in the registry and joins
   * each with its `institutions` row + `institution_types` row. Returns
   * the full payload the frontend integrations page renders from.
   */
  listAvailable: protectedProcedure.query(async () => {
    const registry = Container.get(ProviderRegistry);
    const manifests = registry.listIntegrationManifests();
    if (manifests.length === 0) return [];

    const names = manifests.map((m) => m.institutionName);
    const rows = await db
      .select({
        institution: schema.institutions,
        type: schema.institutionTypes,
      })
      .from(schema.institutions)
      .leftJoin(schema.institutionTypes, eq(schema.institutions.typeId, schema.institutionTypes.id))
      .where(inArray(schema.institutions.name, names));

    const byName = new Map(rows.map((r) => [r.institution.name, r]));

    return manifests
      .map((manifest) => {
        const row = byName.get(manifest.institutionName);
        if (!row) {
          // Boot-time validation should prevent this — if a manifest
          // references a name not present in the institutions table,
          // logs surface it but the integration just doesn't render.
          return null;
        }
        return {
          providerKey: manifest.providerKey,
          credentialFields: manifest.credentialFields,
          instructions: manifest.instructions,
          institution: {
            id: row.institution.id,
            name: row.institution.name,
            description: row.institution.description,
            website: row.institution.website,
            logoUrl: row.institution.logoUrl,
            type: row.type ? { code: row.type.code, name: row.type.name } : null,
          },
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }),

  /**
   * Generic credential validation + import enqueue. Replaces the prior
   * 14 per-provider mutations. Payload shape is validated against the
   * provider's manifest at runtime — the only static schema is the
   * envelope (`providerKey`, `credentials` map, `requestId`).
   */
  validateKeys: protectedProcedure
    .input(
      z.object({
        providerKey: z.string().min(1, 'providerKey is required'),
        credentials: z.record(z.string(), z.string()),
        requestId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Per-user budget: reject before doing any expensive work
      // (manifest lookup, credential decryption, upstream HTTP).
      const budget = await validateKeysLimiter.tryConsume(ctx.userId);
      if (!budget.ok) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Too many credential validation attempts. Try again in ${Math.ceil(budget.retryAfterMs / 1000)}s.`,
        });
      }

      const registry = Container.get(ProviderRegistry);
      const manifest = registry.getIntegrationManifest(input.providerKey);
      if (!manifest) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Unknown integration provider: ${input.providerKey}`,
        });
      }

      assertCredentialsMatchManifest(manifest, input.credentials);

      // Some providers (IBKR's Flex Web Service) defer validation to
      // the worker — the upstream is rate-limited per token, so a
      // pre-validate burns the only call. Skip the registry lookup and
      // go straight to store + enqueue.
      if (!manifest.skipServerValidation) {
        const validator = registry.getCredentialValidator(manifest.providerKey);
        if (!validator) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `No credential validator registered for ${manifest.providerKey}`,
          });
        }
        try {
          const result = await validator.validateCredentials(
            input.credentials,
            manifest.providerKey
          );
          if (!result.valid) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: result.message ?? `Invalid ${manifest.institutionName} credentials`,
            });
          }
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          // Preserve upstream provider's message (e.g. Kraken's
          // "EAPI:Invalid signature") so the UI surfaces the actual cause.
          const upstream = error instanceof Error && error.message ? error.message : String(error);
          throw toTRPCError(error, {
            fallbackCode: 'BAD_REQUEST',
            fallbackMessage: `${manifest.institutionName}: ${upstream}`,
          });
        }
      }

      try {
        const { institutionId, jobId } = await storeAndEnqueueImport(
          ctx.userId,
          manifest.institutionName,
          input.credentials,
          input.requestId
        );
        Container.get(AnalyticsService).capture({
          distinctId: ctx.userId,
          event: ANALYTICS_EVENTS.accountConnected,
          app: 'backend',
          properties: {
            provider: manifest.providerKey,
            institution: manifest.institutionName,
          },
        });
        return {
          success: true,
          message: `${manifest.institutionName} credentials stored — running import`,
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
