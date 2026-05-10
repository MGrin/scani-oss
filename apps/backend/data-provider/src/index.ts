// reflect-metadata must load before any @Service() class, since
// typedi reads decorator metadata at class-init time. Without it,
// `Reflect.getMetadata is undefined` blows up the provider registry.
import 'reflect-metadata';

// CRITICAL: Validate env before importing anything that reads it.
import { loadEnv } from './config/env';

const env = loadEnv();

import { cors } from '@elysiajs/cors';
import { trpc } from '@elysiajs/trpc';
import { createTimer, logger, sanitizeUrl } from '@scani/logging';
import { flushSentry, initSentry, captureException as sentryCapture } from '@scani/logging/sentry';
import { buildProviderRegistry } from '@scani/providers/core/boot';
import { aiOpenAIFactory } from '@scani/providers/providers/ai-openai';
import { bitcoinFactory } from '@scani/providers/providers/bitcoin';
import { coingeckoFactory } from '@scani/providers/providers/coingecko';
import { defillamaFactory } from '@scani/providers/providers/defillama';
import { etherscanFactory } from '@scani/providers/providers/etherscan';
import { finnhubFactory } from '@scani/providers/providers/finnhub';
import { frankfurterFactory } from '@scani/providers/providers/frankfurter';
import { solanaFactory } from '@scani/providers/providers/solana';
import { tonFactory } from '@scani/providers/providers/ton';
import { tronFactory } from '@scani/providers/providers/tron';
import { yahooFinanceFactory } from '@scani/providers/providers/yahoo-finance';
import { createOutflowLimiter, setSharedRedis } from '@scani/rate-limiter';
import { StorageService } from '@scani/storage';
import { Elysia } from 'elysia';
import { Redis } from 'ioredis';
import { Container } from 'typedi';

initSentry({ component: 'data-provider', release: env.SENTRY_RELEASE });

import { type CloudBetterAuthInstance, createCloudBetterAuth } from './auth/better-auth';
import { type CloudDb, closeCloudDb, getCloudDb } from './db/connection';
import { buildOpenApiDocument, renderScalarHtml } from './presentation/openapi';
import {
  appRouter,
  installCloudDb,
  installUsageDeps,
  installWaitlistCloudDb,
} from './presentation/router';
import {
  buildCreateContext,
  getActiveUsageSink,
  installGlobalCostBreaker,
  installQuotaLimiter,
  installUsageSink,
} from './presentation/trpc';
import { GlobalCostBreaker } from './usage/global-cost-breaker';
import { NoopUsageSink, PostgresUsageSink, type UsageSink } from './usage/sink';

const PORT = env.PORT;
const HOST = env.HOST;

logger.info({ port: PORT, host: HOST, nodeEnv: env.NODE_ENV }, '🚀 Starting Scani Data-Provider');

// Redis powers per-provider rate-limit buckets. Upstream 3rd-party APIs
// (CoinGecko / Etherscan / Helius / …) apply global per-key limits, so the
// buckets live in Redis where every data-provider replica shares fairness.
const redisConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
setSharedRedis(redisConnection);

// Object storage self-loads from S3_* env vars (see @scani/storage).

// Boot state — deliberately mutated post-listen() so the server can bind
// to its port BEFORE provider-registry / cloud-management init runs.
// Without this split, the heavy init can hold the event loop long enough
// that Fly's HTTP health check trips its grace_period before the server
// is even listening. The /ready endpoint reads `bootState.ready` so Fly
// only routes traffic once init has completed.
interface DataProviderBootState {
  ready: boolean;
  cloudDb: CloudDb | null;
  betterAuth: CloudBetterAuthInstance | null;
}
const bootState: DataProviderBootState = {
  ready: false,
  cloudDb: null,
  betterAuth: null,
};

// Pre-install no-op deps so any request that races boot completion
// finds a sensible default (rather than NPE-ing on a null sink).
installUsageSink(new NoopUsageSink());
installCloudDb(null);
installUsageDeps({ db: null });
installWaitlistCloudDb(null);

interface RequestWithTracking extends Request {
  _timer?: { end: () => number };
  _requestId?: string;
}

const app = new Elysia()
  .onBeforeHandle(({ request, set }) => {
    const url = new URL(request.url);
    // Respect a caller-supplied x-request-id so backend → data-provider →
    // Sentry traces stitch together. Generate one only when missing.
    const incomingRequestId = request.headers.get('x-request-id');
    const requestId = incomingRequestId ?? crypto.randomUUID();
    const timer = createTimer();

    set.headers = set.headers || {};
    set.headers['x-request-id'] = requestId;

    const isHealthCheck = url.pathname === '/health';
    const shouldSkipLogging = isHealthCheck || request.method === 'OPTIONS';

    if (!shouldSkipLogging) {
      logger.info(
        {
          requestId,
          method: request.method,
          url: sanitizeUrl(request.url),
          origin: request.headers.get('origin'),
        },
        '📨 HTTP Request received'
      );
    }

    (request as RequestWithTracking)._timer = timer;
    (request as RequestWithTracking)._requestId = requestId;
  })
  .onAfterHandle(({ request, response, set }) => {
    const tracked = request as RequestWithTracking;
    const duration = tracked._timer?.end();
    const url = new URL(request.url);
    const isHealthCheck = url.pathname === '/health';
    if (!isHealthCheck && request.method !== 'OPTIONS') {
      const statusCode =
        typeof set.status === 'number'
          ? set.status
          : set.status
            ? parseInt(String(set.status), 10)
            : 200;
      logger.info(
        {
          requestId: tracked._requestId,
          method: request.method,
          url: sanitizeUrl(request.url),
          statusCode,
          duration: duration ? `${duration}ms` : undefined,
        },
        statusCode >= 400 ? '⚠️ HTTP Response sent with error status' : '✅ HTTP Response sent'
      );
    }
    return response;
  })
  // Security headers — applied to every response. The api app sets the
  // same set; the data-provider serves the same kind of bearer-auth API
  // surface, so the headers should match. CSP defaults to `default-src
  // 'none'` because this service returns JSON; no inline scripts, no
  // images. HSTS only ships in production where TLS is guaranteed.
  // The one exception is `/docs`, which embeds Scalar's API-reference
  // bundle from jsdelivr — that page swaps in a Scalar-friendly CSP
  // that whitelists the CDN + the assets Scalar fetches at runtime.
  .onAfterHandle(({ request, set }) => {
    set.headers = set.headers || {};
    set.headers['X-Content-Type-Options'] = 'nosniff';
    set.headers['X-Frame-Options'] = 'DENY';
    set.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
    const isDocsPage = new URL(request.url).pathname === '/docs';
    set.headers['Content-Security-Policy'] = isDocsPage
      ? [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
          "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
          "font-src 'self' data: https://cdn.jsdelivr.net https://fonts.gstatic.com",
          "img-src 'self' data: https:",
          "connect-src 'self'",
          "worker-src 'self' blob:",
        ].join('; ')
      : "default-src 'none'";
    if (process.env.NODE_ENV === 'production') {
      set.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains; preload';
    }
  })
  .onError(({ error, request, set }) => {
    const tracked = request as RequestWithTracking;
    const requestId = tracked._requestId;
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(
      { requestId, url: sanitizeUrl(request.url), error: message },
      `💥 HTTP Request failed: ${message}`
    );
    sentryCapture(error, { requestId: requestId ?? 'unknown', url: sanitizeUrl(request.url) });
    set.status = 500;
    return { error: 'Internal Server Error', message, requestId };
  })
  .use(
    cors({
      // Wide-open CORS by default: callers are backend/worker over private
      // net (no browser origin) + cloud-frontend (which lives on the same
      // TLD in managed deployments, so the Pages origin is appended at
      // deploy-time via env). FE-1/FE-2 will narrow this to the
      // cloud-frontend origin for cookie-session endpoints.
      origin: true,
      credentials: true,
      allowedHeaders: ['Authorization', 'Content-Type', 'x-request-id'],
      // Default `*` makes @elysiajs/cors echo every inbound request
      // header (incl. `via`, `host`, `fly-client-ip`, `x-forwarded-*`).
      // Browser callers only need `x-request-id` for tracing.
      exposeHeaders: ['x-request-id'],
    })
  )
  .use(
    trpc(appRouter, {
      createContext: buildCreateContext({
        env,
        getCloudDb: () => bootState.cloudDb,
        getBetterAuth: () => bootState.betterAuth,
        // biome-ignore lint/suspicious/noExplicitAny: elysia trpc types
      }) as any,
      endpoint: '/trpc',
    })
  )
  // Better-Auth for cloud-frontend cookie sessions.
  //
  // Bridging Elysia → WinterCG-style handler is surprisingly subtle:
  //   * Elysia's default body parser consumes the request stream, so
  //     Better-Auth's `.json()` call inside `handler()` hits
  //     ERR_BODY_ALREADY_USED.
  //   * Elysia's `.mount()` helper strips the mount prefix before
  //     calling the handler, which breaks Better-Auth's internal
  //     router (it matches on `/api/auth/...` literally).
  //   * `.mount()` without a path registers at `/*` and changes
  //     request lifecycle semantics.
  //
  // The working pattern: intercept early in `onRequest` (which runs
  // before body parsing), forward the raw `Request` to Better-Auth,
  // and short-circuit the Elysia lifecycle by returning a Response.
  .onRequest(async ({ request }) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/auth')) return;
    const auth = bootState.betterAuth;
    if (!auth) {
      // Either CLOUD_MANAGEMENT_ENABLED=false (legitimate) or boot
      // hasn't finished yet (transient). Same response either way —
      // /ready will tell the caller which case applies.
      return new Response(JSON.stringify({ error: 'cloud_management_unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    return auth.handler(request);
  })
  .get('/', () => ({ status: 'ok', service: 'scani-data-provider' }))
  // OpenAPI 3.0 spec for the bearer-auth tRPC surface. Generated once
  // at boot from `appRouter`'s .meta() annotations and post-processed
  // so it accurately describes the `?input=<JSON>` query convention
  // tRPC v10 uses on the wire (see ./presentation/openapi.ts). The
  // SENTRY_RELEASE doubles as the spec version so docs and code never
  // disagree about which build a customer is calling.
  .get('/openapi.json', () =>
    buildOpenApiDocument(appRouter, {
      baseUrl: env.PUBLIC_BASE_URL ?? `http://${HOST}:${PORT}`,
      version: env.SENTRY_RELEASE ?? '0.0.0-dev',
    })
  )
  // Browseable API reference. Loads Scalar from a CDN so we don't
  // bundle the UI; the page is ~15 lines of HTML and the actual UI
  // is rendered client-side against /openapi.json.
  .get('/docs', ({ set }: { set: { headers: Record<string, string> } }) => {
    set.headers['Content-Type'] = 'text/html; charset=utf-8';
    return renderScalarHtml('/openapi.json');
  })
  // Liveness — process is alive. Returns 200 from the moment Elysia
  // starts listening, even before init finishes. Useful for app-level
  // deep-health probes; NOT what Fly's machine check uses (see /ready).
  .get('/health', () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  }))
  .head('/health', ({ set }: { set: { status: number; headers: Record<string, string> } }) => {
    set.status = 200;
    set.headers['Content-Type'] = 'application/json';
    return;
  })
  // Readiness — only 200 once boot is fully complete (provider registry
  // built, cloud DB pool open if enabled, Better-Auth wired if enabled).
  // Fly's machine check probes this so traffic isn't routed to a freshly
  // started replica that's still constructing its registry. Returns 503
  // with `{ status: 'starting' }` until the boot IIFE flips the flag.
  .get('/ready', ({ set }: { set: { status: number } }) => {
    if (!bootState.ready) {
      set.status = 503;
      return { status: 'starting', timestamp: new Date().toISOString() };
    }
    return { status: 'ok', ready: true, timestamp: new Date().toISOString() };
  })
  .head('/ready', ({ set }: { set: { status: number } }) => {
    set.status = bootState.ready ? 200 : 503;
    return;
  })
  // Probe of the R2 bucket the data-provider holds credentials for.
  // Backend's /health proxies through this so a storage outage shows up
  // as `r2.ok=false` on the consumer side instead of being silently
  // masked by a hard-coded "ok" in cloud mode. Auth is intentionally
  // skipped: this endpoint reveals no secrets and is called from
  // load-balancer + sibling-service liveness probes.
  .get(
    '/health/r2',
    async ({ set }: { set: { status: number; headers: Record<string, string> } }) => {
      const result = await Container.get(StorageService).healthCheck();
      if (!result.ok) set.status = 503;
      return result;
    }
  );

const server = app.listen({ port: PORT, hostname: HOST }, () => {
  logger.info(
    { httpUrl: `http://${HOST}:${PORT}`, environment: process.env.NODE_ENV || 'development' },
    '🎉 Scani Data-Provider listening — running deferred init'
  );
});

// Deferred boot: heavy work (provider registry, cloud DB pool, Better-Auth
// instance) runs AFTER the HTTP listener is up so Fly's health probe can
// reach the process while init is still in flight. /ready returns 503
// throughout this phase, then 200 once `bootState.ready` flips.
//
// On boot failure we exit hard — there's no partial-success state where
// the process should keep accepting traffic.
void (async () => {
  const bootStart = Date.now();
  // Retry the heavy init with exponential backoff before giving up.
  // The previous version called process.exit(1) on the first failure,
  // which turned a transient CoinGecko / Postgres / Upstash hiccup at
  // boot into a Fly crash-loop. With max-restart-count=10 on Fly,
  // ten transient failures = machine `stopped` indefinitely.
  //
  // Backoff: 5s, 15s, 30s, 60s (cap), 60s, 60s, 60s, 60s, 60s. After
  // 10 attempts (~8 minutes total) we exit so Fly's restart restarts
  // the process from clean state — at that point a real bug, not
  // transient flake.
  const MAX_BOOT_ATTEMPTS = 10;
  const backoffMs = (attempt: number) => Math.min(60_000, 5_000 * 2 ** Math.min(attempt, 4));
  for (let attempt = 1; attempt <= MAX_BOOT_ATTEMPTS; attempt++) {
    try {
      // Stand up the @scani/providers registry. The data-provider
      // runs in `direct` mode — it holds the platform-credentialed
      // provider instances and exposes them to backend/worker via
      // the tRPC routers.
      await buildProviderRegistry({
        mode: 'direct',
        redis: redisConnection,
        env: process.env,
        providers: [
          defillamaFactory,
          frankfurterFactory,
          coingeckoFactory,
          finnhubFactory,
          // Yahoo runs after Finnhub: covers non-US equities (.TO,
          // .NE/.NEO, .L, .DE, …) and Frankfurter-unsupported fiat
          // (RUB, KZT, GEL, AED, …).
          yahooFinanceFactory,
          // Chain providers — public-endpoint balance + address-validator
          // dispatch. ENV vars (ETHERSCAN_API_KEY, HELIUS_API_KEY,
          // TRON_API_URL, TON_API_URL) are read inside each factory.
          etherscanFactory,
          bitcoinFactory,
          solanaFactory,
          tronFactory,
          tonFactory,
          // AI: OpenAI is the only AI provider.
          aiOpenAIFactory,
        ],
      });
      logger.info({ attempt }, '✅ @scani/providers registry initialized');

      // Tier 2/3 only: open the Postgres pool for `cloud_*` (api keys
      // + users) + `cloud_usage_events`, enable Postgres-backed
      // per-request metering, and bootstrap Better-Auth for
      // cloud-frontend cookie sessions. Tier 1 OSS boots with no DB
      // and a NoopUsageSink.
      let usageSink: UsageSink = new NoopUsageSink();
      if (env.CLOUD_MANAGEMENT_ENABLED && env.DATABASE_URL) {
        const cloudDb = getCloudDb(env.DATABASE_URL);
        bootState.cloudDb = cloudDb;
        usageSink = new PostgresUsageSink({ db: cloudDb });
        logger.info({}, 'usage-sink: Postgres enabled for per-request metering');
        if (env.BETTER_AUTH_SECRET && env.BETTER_AUTH_URL) {
          bootState.betterAuth = createCloudBetterAuth({
            db: cloudDb,
            baseURL: env.BETTER_AUTH_URL,
            secret: env.BETTER_AUTH_SECRET,
            trustedOrigins: env.CLOUD_FRONTEND_ORIGIN ? [env.CLOUD_FRONTEND_ORIGIN] : [],
          });
          logger.info(
            { cloudFrontendOrigin: env.CLOUD_FRONTEND_ORIGIN },
            'cloud-auth: Better-Auth enabled for cloud-frontend sessions'
          );
        }
        installCloudDb(cloudDb);
        installUsageDeps({ db: cloudDb });
        installWaitlistCloudDb(cloudDb);
        logger.info({}, 'cloud management enabled: DB-backed api keys + usage log');
      }
      installUsageSink(usageSink);

      // Per-API-key hourly quota. Disabled when CLOUD_QUOTA_HOURLY_DEFAULT
      // is 0 / unset (OSS / dev). The limiter is keyed by apiKeyId so
      // each of a tenant's keys carries an independent budget;
      // future per-tier overrides can swap in a multi-tier registry
      // without changing the middleware contract.
      if (env.CLOUD_QUOTA_HOURLY_DEFAULT > 0) {
        installQuotaLimiter(
          createOutflowLimiter({
            maxRequests: env.CLOUD_QUOTA_HOURLY_DEFAULT,
            windowMs: 60 * 60 * 1000,
            redis: redisConnection,
            namespace: 'quota:hourly',
          })
        );
        logger.info(
          { hourlyDefault: env.CLOUD_QUOTA_HOURLY_DEFAULT },
          'quota: per-API-key hourly budget enabled'
        );
      }

      // Org-wide hourly cost breaker. Disabled when GLOBAL_HOURLY_USD_CAP
      // is 0 / unset. Tracks cumulative `upstreamCostUsd` across ALL
      // tenants in Redis; tripped state rejects new requests with 503
      // until the next hour-bucket starts. Catches runaway loops that
      // bypass the per-API-key quota.
      if (env.GLOBAL_HOURLY_USD_CAP > 0) {
        installGlobalCostBreaker(
          new GlobalCostBreaker(redisConnection, {
            hourlyUsdCap: env.GLOBAL_HOURLY_USD_CAP,
          })
        );
        logger.info(
          { hourlyUsdCap: env.GLOBAL_HOURLY_USD_CAP },
          'cost-breaker: global hourly USD cap enabled'
        );
      }

      bootState.ready = true;
      logger.info(
        { bootDurationMs: Date.now() - bootStart, attempt },
        '🎯 Boot complete — /ready now returns 200'
      );
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const wait = backoffMs(attempt);
      if (attempt < MAX_BOOT_ATTEMPTS) {
        logger.warn(
          { err: message, attempt, nextDelayMs: wait },
          `⚠️  Deferred boot attempt ${attempt}/${MAX_BOOT_ATTEMPTS} failed — retrying`
        );
        sentryCapture(err instanceof Error ? err : new Error(message), {
          kind: 'data-provider-boot-retry',
          attempt: String(attempt),
        });
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      logger.fatal(
        { err: message, attempt, bootDurationMs: Date.now() - bootStart },
        `💀 Deferred boot failed after ${MAX_BOOT_ATTEMPTS} attempts — exiting`
      );
      sentryCapture(err instanceof Error ? err : new Error(message), {
        kind: 'data-provider-boot-exhausted',
        attempts: String(MAX_BOOT_ATTEMPTS),
      });
      await flushSentry(2000);
      process.exit(1);
    }
  }
})();

const SHUTDOWN_HARD_CAP_MS = 10_000;
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, '🛑 Graceful shutdown initiated');
  const hardTimer = setTimeout(() => {
    logger.error({ capMs: SHUTDOWN_HARD_CAP_MS }, '⏱️ Shutdown cap reached — forcing exit');
    process.exit(1);
  }, SHUTDOWN_HARD_CAP_MS);
  hardTimer.unref?.();
  try {
    server.stop();
    // Drain buffered usage events before the process exits. Read via
    // the trpc module's getter — the active sink is swapped in the
    // deferred boot IIFE, so this picks up whichever one is current
    // (NoopUsageSink if shutdown fires before boot completed).
    await getActiveUsageSink()
      .flush()
      .catch(() => undefined);
    await closeCloudDb();
    await redisConnection.quit().catch(() => undefined);
    await flushSentry(2000);
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during graceful shutdown');
    process.exit(1);
  }
};

process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
  logger.fatal(
    { error: { name: error.name, message: error.message, stack: error.stack } },
    '💀 Uncaught Exception - shutting down'
  );
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, '💀 Unhandled Promise Rejection - shutting down');
  process.exit(1);
});

export type { AppRouter } from './presentation/router';
