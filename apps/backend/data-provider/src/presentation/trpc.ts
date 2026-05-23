import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { initTRPC, TRPCError } from '@trpc/server';
import type { OpenApiMeta } from 'trpc-openapi';
import type { ApiKeyContext } from '../auth/api-key';
import { validateBearerToken } from '../auth/api-key';
import type { CloudBetterAuthInstance } from '../auth/better-auth';
import type { DataProviderEnv } from '../config/env';
import type { CloudDb } from '../db/connection';
import type { GlobalCostBreaker } from '../usage/global-cost-breaker';
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
  // Best-effort client IP, read from `x-forwarded-for` (Fly's edge sets
  // this) or `fly-client-ip`. Used by public procedures (e.g.
  // contact.submit) for per-IP rate limiting; never persisted
  // unhashed. Null when no
  // header is present (direct internal calls / tests).
  clientIp: string | null;
}

export interface BuildContextDeps {
  env: DataProviderEnv;
  // Getter-based so the Elysia app can be constructed (and the server
  // can start listening) before cloud init has populated cloudDb /
  // betterAuth. Without this, the trpc plugin captures `null`s at
  // construct-time and never sees the post-init values. Each request
  // re-reads the current value via these getters.
  getCloudDb: () => CloudDb | null;
  getBetterAuth: () => CloudBetterAuthInstance | null;
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
export function buildCreateContext({ env, getCloudDb, getBetterAuth }: BuildContextDeps) {
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
        cloudDb: getCloudDb(),
      });
    } catch {
      // Bearer token absent or invalid; the cookie path may still let
      // the request through. Procedures that require M2M re-check `ctx.auth`.
      auth = null;
    }

    let cloudUser: CloudSessionUser | null = null;
    const betterAuth = getBetterAuth();
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

    // Fly's `fly-client-ip` is a single value, set at the edge, and is
    // the most reliable source. `x-forwarded-for` is a comma-delimited
    // list where Fly and Cloudflare APPEND the real client IP at the
    // tail — the leftmost entries are attacker-controllable, so we trust
    // only the rightmost element. Keying off the leftmost entry would
    // let a caller rotate fake prefixes and trivially bypass per-IP
    // rate limits (e.g. contact.submit). Matches the rule applied by
    // @scani/rate-limiter's defaultInflowKey.
    const flyClientIp = req.headers.get('fly-client-ip');
    const xff = req.headers.get('x-forwarded-for');
    const xffTail = xff
      ?.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .at(-1);
    const clientIp = flyClientIp ?? xffTail ?? null;

    return { auth, cloudUser, requestId, usage: createUsageContext(), clientIp };
  };
}

const t = initTRPC.context<DataProviderContext>().meta<OpenApiMeta>().create();

let activeSink: UsageSink = new NoopUsageSink();
let activeQuotaLimiter: OutflowRateLimiter | null = null;
let activeGlobalCostBreaker: GlobalCostBreaker | null = null;

export function installUsageSink(sink: UsageSink): void {
  activeSink = sink;
}

// Read the currently-installed sink. Used by index.ts's graceful
// shutdown to flush pending usage events; needed because `activeSink`
// is module-private and gets swapped in the deferred boot IIFE.
export function getActiveUsageSink(): UsageSink {
  return activeSink;
}

export function installQuotaLimiter(limiter: OutflowRateLimiter | null): void {
  activeQuotaLimiter = limiter;
}

export function installGlobalCostBreaker(breaker: GlobalCostBreaker | null): void {
  activeGlobalCostBreaker = breaker;
}

// biome-ignore lint/suspicious/noExplicitAny: tRPC's MiddlewareResult is branded
const usageMiddleware = t.middleware((opts: any) =>
  buildUsageMiddleware({
    sink: activeSink,
    quotaLimiter: activeQuotaLimiter,
    globalCostBreaker: activeGlobalCostBreaker,
  })(opts)
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
