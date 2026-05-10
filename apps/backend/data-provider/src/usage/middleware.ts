/**
 * Per-request usage-log middleware.
 *
 * Wraps every tRPC procedure; on completion (success or error) records one
 * row via the active `UsageSink`. The `provider` field is derived from the
 * router namespace (`ai.*` → `ai`, `pricing.*` → `pricing`, …) so the
 * /usage dashboard can slice by provider without each router having to
 * declare itself.
 *
 * Routers that need finer-grained attribution (e.g. "this call hit
 * OpenAI" vs. "this call hit DeepSeek") can enrich the event via
 * `ctx.usage.annotate({...})` inside the resolver; the middleware merges
 * the annotations into the final event.
 */

import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { TRPCError } from '@trpc/server';
import type { GlobalCostBreaker } from './global-cost-breaker';
import type { UsageEvent, UsageSink } from './sink';

export interface UsageAnnotation {
  provider?: string;
  tokensIn?: number;
  tokensOut?: number;
  bytesIn?: number;
  bytesOut?: number;
  upstreamCostUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface UsageContext {
  annotate(patch: UsageAnnotation): void;
  getAnnotation(): UsageAnnotation;
}

export function createUsageContext(): UsageContext {
  let annotation: UsageAnnotation = {};
  return {
    annotate(patch) {
      annotation = {
        ...annotation,
        ...patch,
        metadata: { ...(annotation.metadata ?? {}), ...(patch.metadata ?? {}) },
      };
    },
    getAnnotation() {
      return annotation;
    },
  };
}

interface BuildDeps {
  sink: UsageSink;
  /**
   * Optional per-API-key hourly budget. When provided, the middleware
   * rejects requests with `FORBIDDEN { code: 'quota_exceeded' }` once
   * the running counter for the calling api key exceeds the limit.
   * OSS / superuser / cookie-session callers (apiKeyId == null or the
   * shared OSS marker) bypass the check — they're already gated by
   * separate auth flows. Pass `null` to disable.
   */
  quotaLimiter?: OutflowRateLimiter | null;
  /**
   * Optional global org-wide hourly cost breaker. Trips when the
   * cumulative `upstreamCostUsd` across ALL tenants exceeds the cap.
   * Sentry-captures the trip, then rejects subsequent requests with
   * `SERVICE_UNAVAILABLE { code: 'global_cost_cap' }` until the next
   * hour-bucket. Pass `null` to disable.
   */
  globalCostBreaker?: GlobalCostBreaker | null;
}

interface BaseCtx {
  // `auth` is null for cookie-session requests from cloud-frontend —
  // the inner cookie procedure synthesises a marker after this
  // middleware runs, so we tolerate null here and fall back to the
  // cloud-user id for the subject.
  auth: { apiKeyId: string; tenantId: string; ownerUserId: string | null } | null;
  cloudUser: { id: string } | null;
  requestId: string;
  usage: UsageContext;
}

// tRPC's MiddlewareOpts has a branded `marker` in its MiddlewareResult,
// which is deliberately internal. We accept `any` for the opts shape but
// keep the body type-safe via `BaseCtx`.
// biome-ignore lint/suspicious/noExplicitAny: see above
type MwOpts = { ctx: BaseCtx; path: string; type: string; next: (o?: any) => Promise<any> };

/**
 * Pure factory — keeps the middleware decoupled from `initTRPC` so it can
 * be attached to both `publicProcedure` and `bearerProcedure` in trpc.ts.
 */
export function buildUsageMiddleware({ sink, quotaLimiter, globalCostBreaker }: BuildDeps) {
  return async (opts: MwOpts) => {
    const start = Date.now();
    const { ctx, path, next } = opts;
    const provider = derivePrimaryProvider(path);
    let outcome: UsageEvent['outcome'] = 'ok';
    let statusCode: number | undefined;
    let errorCode: string | undefined;

    // Global cost breaker — fires BEFORE the per-key quota check so a
    // runaway loop on one tenant can't burn unbounded org-wide spend
    // before its per-key counter notices. The breaker is org-wide,
    // not per-tenant; one tripped breaker blocks everyone, which is
    // the right call: we'd rather refuse all paid traffic than
    // burn an unbounded bill while we figure out which tenant is
    // misbehaving.
    if (globalCostBreaker?.enabled()) {
      const breakerResult = await globalCostBreaker.shouldAllow();
      if (!breakerResult.ok) {
        ctx.usage.annotate({
          provider,
          metadata: {
            globalCostCapUsd: breakerResult.capUsd,
            globalCurrentUsd: breakerResult.currentUsd,
          },
        });
        // tRPC has no SERVICE_UNAVAILABLE code; FORBIDDEN matches the
        // existing per-key quota_exceeded shape so callers' retry
        // logic doesn't need to differentiate. The
        // `code = 'global_cost_cap'` in the message lets observability
        // distinguish org-wide cap from per-key cap.
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'global_cost_cap',
        });
      }
    }

    // Per-key hourly quota. Skip when no limiter is wired (OSS / dev),
    // when the request is unauthenticated (cookie path takes over),
    // when it's the OSS shared key (no per-key counter), or when there
    // is no tenantId attribution. The limiter is keyed by apiKeyId so
    // a single tenant's keys carry independent budgets.
    if (
      quotaLimiter &&
      ctx.auth &&
      ctx.auth.apiKeyId !== 'oss-shared-key' &&
      ctx.auth.tenantId !== 'oss' &&
      ctx.auth.tenantId !== 'dev'
    ) {
      const budget = await quotaLimiter.tryConsume(ctx.auth.apiKeyId);
      if (!budget.ok) {
        const retryAfterSec = Math.ceil(budget.retryAfterMs / 1000);
        // Annotate so the sink records the rejected event with the
        // tenant attribution intact (otherwise the throw below skips
        // record() in the caller's catch path).
        ctx.usage.annotate({
          provider,
          metadata: { quotaRetryAfterSec: retryAfterSec },
        });
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `quota_exceeded — retry in ${retryAfterSec}s`,
        });
      }
    }

    try {
      const result = await next();
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        outcome = mapErrorToOutcome(result.error);
        errorCode = result.error.code;
        statusCode = mapCodeToStatus(result.error.code);
      } else {
        statusCode = 200;
      }
      return result;
    } catch (err) {
      // Mirror the success-path outcome mapping so a thrown TRPCError
      // surfaces as `rate_limited` / `unauthorized` / `quota_exceeded`
      // on the dashboard instead of a generic `error` — otherwise the
      // /usage breakdown undercounts every category that ever throws.
      if (err instanceof TRPCError) {
        outcome = mapErrorToOutcome(err);
        errorCode = err.code;
        statusCode = mapCodeToStatus(err.code);
      } else {
        outcome = 'error';
        errorCode = 'INTERNAL_SERVER_ERROR';
        statusCode = 500;
      }
      throw err;
    } finally {
      const durationMs = Date.now() - start;
      const annotation = ctx.usage.getAnnotation();
      const apiKeyId =
        !ctx.auth || ctx.auth.apiKeyId === 'oss-shared-key' ? null : ctx.auth.apiKeyId;
      const tenantId =
        !ctx.auth || ctx.auth.tenantId === 'oss' || ctx.auth.tenantId === 'dev'
          ? null
          : ctx.auth.tenantId;
      // Subject = owning cloud_user (Tier 2) or tenant (future multi-user
      // workspaces). Cookie-session requests don't flow through the
      // bearer-auth path so `ctx.auth` is null here — fall back to the
      // authenticated cloud-frontend user. OSS env-key auth has no owner
      // and the sink drops the event.
      const subject = ctx.auth?.ownerUserId ?? ctx.cloudUser?.id ?? tenantId;
      sink.record({
        apiKeyId,
        tenantId,
        subject,
        requestId: ctx.requestId,
        route: path,
        provider: annotation.provider ?? provider,
        outcome,
        statusCode,
        durationMs,
        tokensIn: annotation.tokensIn,
        tokensOut: annotation.tokensOut,
        bytesIn: annotation.bytesIn,
        bytesOut: annotation.bytesOut,
        upstreamCostUsd: annotation.upstreamCostUsd,
        errorCode,
        metadata: annotation.metadata,
      });
      // Tally into the global cost breaker post-flight. Best-effort;
      // failures are swallowed inside `record()`.
      if (
        globalCostBreaker?.enabled() &&
        annotation.upstreamCostUsd &&
        annotation.upstreamCostUsd > 0
      ) {
        void globalCostBreaker.record(annotation.upstreamCostUsd);
      }
    }
  };
}

function derivePrimaryProvider(path: string): string {
  // tRPC paths come in as e.g. "ai.vision.extract" or "pricing.getPrice";
  // the top-level namespace matches our router split (ai/pricing/chains/…)
  // which doubles as the "provider family" on the usage dashboard.
  const [head] = path.split('.');
  return head || 'unknown';
}

function mapErrorToOutcome(err: TRPCError): UsageEvent['outcome'] {
  switch (err.code) {
    case 'UNAUTHORIZED':
      return 'unauthorized';
    case 'TOO_MANY_REQUESTS':
      return 'rate_limited';
    case 'FORBIDDEN':
      // Quota-exhausted surfaces as FORBIDDEN with a specific message.
      if (err.message.toLowerCase().includes('quota')) return 'quota_exceeded';
      return 'error';
    default:
      return 'error';
  }
}

function mapCodeToStatus(code: string): number {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'TIMEOUT':
      return 408;
    case 'CONFLICT':
      return 409;
    case 'PRECONDITION_FAILED':
      return 412;
    case 'PAYLOAD_TOO_LARGE':
      return 413;
    case 'METHOD_NOT_SUPPORTED':
      return 405;
    case 'UNPROCESSABLE_CONTENT':
      return 422;
    case 'TOO_MANY_REQUESTS':
      return 429;
    case 'CLIENT_CLOSED_REQUEST':
      return 499;
    case 'BAD_REQUEST':
    case 'PARSE_ERROR':
      return 400;
    default:
      return 500;
  }
}
