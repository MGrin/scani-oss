// CRITICAL: Validate env before importing anything that reads it.
import { loadEnv } from './config/env';

const env = loadEnv();

import { cors } from '@elysiajs/cors';
import { trpc } from '@elysiajs/trpc';
import { createTimer, logger, sanitizeUrl } from '@scani/logging';
import { flushSentry, initSentry, captureException as sentryCapture } from '@scani/logging/sentry';
import { initializeRateLimiterRedis } from '@scani/rate-limiter';
import { Elysia } from 'elysia';
import { Redis } from 'ioredis';

initSentry({ component: 'data-provider', release: env.SENTRY_RELEASE });

import { type CloudBetterAuthInstance, createCloudBetterAuth } from './auth/better-auth';
import { type CloudDb, closeCloudDb, getCloudDb } from './db/connection';
import { appRouter, installCloudDb, installUsageDeps } from './presentation/router';
import { buildCreateContext, installUsageSink } from './presentation/trpc';
import { NoopUsageSink, PostgresUsageSink, type UsageSink } from './usage/sink';

const PORT = env.PORT;
const HOST = env.HOST;

logger.info({ port: PORT, host: HOST, nodeEnv: env.NODE_ENV }, '🚀 Starting Scani Data-Provider');

// Redis powers per-provider rate-limit buckets. Upstream 3rd-party APIs
// (CoinGecko / Etherscan / Helius / …) apply global per-key limits, so the
// buckets live in Redis where every data-provider replica shares fairness.
const redisConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
initializeRateLimiterRedis(redisConnection);

// Tier 2/3 only: open the Postgres pool for `cloud_*` (api keys + users)
// + `cloud_usage_events`, enable Postgres-backed per-request metering, and
// bootstrap Better-Auth for cloud-frontend cookie sessions. Tier 1 OSS boots
// with no DB and a NoopUsageSink.
let cloudDb: CloudDb | null = null;
let betterAuth: CloudBetterAuthInstance | null = null;
let usageSink: UsageSink = new NoopUsageSink();
if (env.CLOUD_MANAGEMENT_ENABLED && env.DATABASE_URL) {
  cloudDb = getCloudDb(env.DATABASE_URL);
  usageSink = new PostgresUsageSink({ db: cloudDb });
  logger.info({}, 'usage-sink: Postgres enabled for per-request metering');
  if (env.BETTER_AUTH_SECRET && env.BETTER_AUTH_URL) {
    betterAuth = createCloudBetterAuth({
      db: cloudDb,
      baseURL: env.BETTER_AUTH_URL,
      secret: env.BETTER_AUTH_SECRET,
      fastmailApiToken: env.FASTMAIL_API_TOKEN,
      smtpUrl: env.SMTP_URL,
      smtpFrom: env.SMTP_FROM,
      trustedOrigins: env.CLOUD_FRONTEND_ORIGIN ? [env.CLOUD_FRONTEND_ORIGIN] : [],
    });
    logger.info(
      { cloudFrontendOrigin: env.CLOUD_FRONTEND_ORIGIN },
      'cloud-auth: Better-Auth enabled for cloud-frontend sessions'
    );
  }
  logger.info({}, 'cloud management enabled: DB-backed api keys + usage log');
}
installUsageSink(usageSink);
installCloudDb(cloudDb);
installUsageDeps({ db: cloudDb });

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
    })
  )
  .use(
    trpc(appRouter, {
      // biome-ignore lint/suspicious/noExplicitAny: elysia trpc types
      createContext: buildCreateContext({ env, cloudDb, betterAuth }) as any,
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
    if (!betterAuth) {
      return new Response(JSON.stringify({ error: 'cloud_management_disabled' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    return betterAuth.handler(request);
  })
  .get('/', () => ({ status: 'ok', service: 'scani-data-provider' }))
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
  // Probe of the R2 bucket the data-provider holds credentials for.
  // Backend's /health proxies through this so a storage outage shows up
  // as `r2.ok=false` on the consumer side instead of being silently
  // masked by a hard-coded "ok" in cloud mode. Auth is intentionally
  // skipped: this endpoint reveals no secrets and is called from
  // load-balancer + sibling-service liveness probes.
  .get(
    '/health/r2',
    async ({ set }: { set: { status: number; headers: Record<string, string> } }) => {
      const { healthCheck } = await import('@scani/storage');
      const result = await healthCheck();
      if (!result.ok) set.status = 503;
      return result;
    }
  );

const server = app.listen({ port: PORT, hostname: HOST }, () => {
  logger.info(
    { httpUrl: `http://${HOST}:${PORT}`, environment: process.env.NODE_ENV || 'development' },
    '🎉 Scani Data-Provider started'
  );
});

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
    // Drain buffered usage events before the process exits.
    await usageSink.flush().catch(() => undefined);
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
