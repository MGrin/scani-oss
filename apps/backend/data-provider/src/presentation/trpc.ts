import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { initTRPC, TRPCError } from '@trpc/server';
import type { ApiKeyContext } from '../auth/api-key';
import { validateBearerToken } from '../auth/api-key';
import type { CloudBetterAuthInstance } from '../auth/better-auth';
import type { DataProviderEnv } from '../config/env';
import type { CloudDb } from '../db/connection';
import { buildUsageMiddleware, createUsageContext, type UsageContext } from '../usage/middleware';
import { NoopUsageSink, type UsageSink } from '../usage/sink';

export interface CloudSessionUser {
  id: string;
  email: string;
  name: string | null;
}

export interface DataProviderContext {
  auth: ApiKeyContext | null;
  cloudUser: CloudSessionUser | null;
  requestId: string;
  usage: UsageContext;
}

export interface BuildContextDeps {
  env: DataProviderEnv;
  cloudDb: CloudDb | null;
  betterAuth: CloudBetterAuthInstance | null;
}

/**
 * Build the tRPC context per request.
 *
 * Two auth strategies coexist:
 *
 *   - Bearer (M2M): `authorization: Bearer <token>` — backend/worker +
 *     `keys`/`usage` routes accessed directly via the raw api key.
 *   - Cookie (browser): Better-Auth session cookie from cloud-frontend;
 *     only consulted when CLOUD_MANAGEMENT_ENABLED=true.
 *
 * If the bearer token is missing or invalid we still resolve the cookie
 * session. `bearerProcedure` / `cookieProcedure` choose which gate they
 * want.
 */
export function buildCreateContext({ env, cloudDb, betterAuth }: BuildContextDeps) {
  return async ({ req }: { req: Request }): Promise<DataProviderContext> => {
    const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();

    let auth: ApiKeyContext | null = null;
    try {
      auth = await validateBearerToken({
        authHeader: req.headers.get('authorization'),
        expectedToken: env.DATA_PROVIDER_API_KEY,
        expectedTokenExpiresAt: env.DATA_PROVIDER_API_KEY_EXPIRES_AT
          ? new Date(env.DATA_PROVIDER_API_KEY_EXPIRES_AT)
          : null,
        cloudDb,
      });
    } catch {
      // Bearer token absent or invalid; the cookie path may still let
      // the request through. Procedures that require M2M re-check `ctx.auth`.
      auth = null;
    }

    let cloudUser: CloudSessionUser | null = null;
    if (betterAuth) {
      try {
        const session = await betterAuth.api.getSession({ headers: req.headers });
        if (session?.user) {
          cloudUser = {
            id: session.user.id,
            email: session.user.email,
            name: session.user.name ?? null,
          };
        }
      } catch {
        /* anonymous */
      }
    }

    return { auth, cloudUser, requestId, usage: createUsageContext() };
  };
}

const t = initTRPC.context<DataProviderContext>().create();

let activeSink: UsageSink = new NoopUsageSink();
let activeQuotaLimiter: OutflowRateLimiter | null = null;

export function installUsageSink(sink: UsageSink): void {
  activeSink = sink;
}

export function installQuotaLimiter(limiter: OutflowRateLimiter | null): void {
  activeQuotaLimiter = limiter;
}

// biome-ignore lint/suspicious/noExplicitAny: tRPC's MiddlewareResult is branded
const usageMiddleware = t.middleware((opts: any) =>
  buildUsageMiddleware({ sink: activeSink, quotaLimiter: activeQuotaLimiter })(opts)
);

export const router = t.router;

/** No auth, no usage log. Reserved for internal health-style routes. */
export const publicProcedure = t.procedure;

/**
 * M2M bearer-token procedure. Used by every existing router (ai, pricing,
 * chains, email, storage, og) that backend/worker call. Records usage.
 */
export const bearerProcedure = t.procedure.use(usageMiddleware).use(({ ctx, next }) => {
  if (!ctx.auth) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Bearer token required' });
  }
  return next({
    ctx: {
      ...ctx,
      auth: ctx.auth, // narrow
    },
  });
});

/**
 * Cookie-session procedure for cloud-frontend routes (keys.*, usage.*).
 * Requires a Better-Auth session. Intentionally NOT wrapped in
 * `usageMiddleware`: dashboard browsing (listing keys, viewing usage)
 * is not billable API consumption — only bearer-authenticated calls
 * from backend/worker/external customers count toward
 * `cloud_usage_events`. Mixing the two pollutes the usage chart with
 * the user's own page reloads.
 */
export const cookieProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.cloudUser) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Cloud session required' });
  }
  return next({
    ctx: {
      ...ctx,
      cloudUser: ctx.cloudUser,
    },
  });
});
