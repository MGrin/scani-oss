import 'reflect-metadata';
// CRITICAL: Validate env vars BEFORE importing anything that reads them.
// loadEnv() will process.exit(1) with a clear error list on misconfiguration.
import { loadEnv } from './config/env';

const env = loadEnv();

import { cors } from '@elysiajs/cors';
import { trpc } from '@elysiajs/trpc';
import { probeDataProvider } from '@scani/cloud-client/health-probe';
import { IntegrationManager } from '@scani/integrations';
import { createTimer, logger, sanitizeUrl, wsLogger } from '@scani/logging';
import { flushSentry, initSentry, captureException as sentryCapture } from '@scani/logging/sentry';
import { initializeRateLimiterRedis } from '@scani/rate-limiter';

// Sentry is the first thing we wire up so any subsequent boot-time failure
// reaches the error tracker instead of being lost to stdout.
initSentry({ component: 'backend', release: env.SENTRY_RELEASE });

// Fail fast if SCANI_CLOUD_URL is set but the data-provider is unreachable.
// Otherwise misconfigs (typo, network split, dead VM) let the backend boot
// healthy and only fail at the first user request — much harder to debug.
// In dev (URL unset) this is a no-op.
{
  const probe = await probeDataProvider({ url: env.SCANI_CLOUD_URL });
  if (!probe.ok) {
    console.error(
      `\n❌ Data-provider unreachable at ${env.SCANI_CLOUD_URL} after ${probe.attempts} attempt(s): ${probe.error ?? `HTTP ${probe.status}`}\n` +
        `Backend cannot start in cloud mode without a healthy data-provider.\n` +
        `Either fix SCANI_CLOUD_URL, restore the data-provider, or unset the env to fall back to local providers.`
    );
    process.exit(1);
  }
  if (env.SCANI_CLOUD_URL) {
    logger.info(
      { url: env.SCANI_CLOUD_URL, attempts: probe.attempts },
      '☁️  Data-provider reachable'
    );
  }
}

import { createStandardLimiter, createStrictLimiter } from '@scani/rate-limiter';
import { RealTimeUpdatesService } from '@scani/realtime';
import { sql } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { Redis } from 'ioredis';
import { Container } from 'typedi';
// CRITICAL: Initialize container BEFORE importing any routers
// This must happen before any module that calls Container.get()
import { createBetterAuth } from './auth/better-auth';
import { initializeContainer } from './config/container';
import { registerAdminJobsRoutes } from './presentation/http/admin-jobs';
import { createContext, setBetterAuthForContext } from './presentation/trpc';
import { closeQueue, initQueueClient } from './queues/client';

initializeContainer();

// Initialize integration registry
try {
  const integrationManager = Container.get(IntegrationManager);
  await integrationManager.initialize();
  logger.info({}, '✅ Integration registry initialized');
} catch (error) {
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    '⚠️ Failed to initialize integration registry - some integrations may not work'
  );
  throw error;
}

// Import database and connection monitoring
import {
  db,
  endConnectionTracking,
  getActiveConnectionsCount,
  getConnectionMonitoringStats,
  getConnectionStats,
  startConnectionTracking,
} from '@scani/db';
// Import router AFTER container is initialized
import { appRouter } from './presentation/router';

const PORT = env.PORT;
const HOST = env.HOST;

// Log startup information
logger.info(
  {
    port: PORT,
    host: HOST,
    nodeEnv: env.NODE_ENV,
    frontendUrl: env.FRONTEND_URL,
    scaniCloudUrl: env.SCANI_CLOUD_URL ?? '(local fallback)',
  },
  '🚀 Starting Scani Backend Server'
);

// Shared ioredis connection — powers BullMQ (enqueue jobs), the rate
// limiter (fairness across horizontally-scaled instances), and the WS
// pub/sub (real-time fan-out across instances).
const redisConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
initQueueClient(redisConnection);
// Make the Redis-backed rate limiter the default for every `new
// RateLimiter(..., { namespace })` in the process. Without this call,
// limiters fall back to per-process in-memory and N backend replicas
// each get their own full upstream-API budget.
initializeRateLimiterRedis(redisConnection);

// Better-Auth is the sole auth provider. BETTER_AUTH_SECRET is validated
// in env.ts (required in prod), but we still guard with a clear runtime
// error message if it's missing in dev for anyone running the backend
// with partial config.
if (!env.BETTER_AUTH_SECRET) {
  throw new Error('BETTER_AUTH_SECRET is required');
}
const betterAuthInstance = createBetterAuth({
  baseURL: env.BACKEND_URL,
  secret: env.BETTER_AUTH_SECRET,
  smtpUrl: env.SMTP_URL,
  smtpFrom: env.SMTP_FROM,
  fastmailApiToken: env.FASTMAIL_API_TOKEN,
  cookieDomain: env.COOKIE_DOMAIN,
  trustedOrigins: [env.FRONTEND_URL],
});
setBetterAuthForContext(betterAuthInstance);
logger.info(
  {
    backendURL: env.BACKEND_URL,
    trustedOrigin: env.FRONTEND_URL,
    cookieDomain: env.COOKIE_DOMAIN,
  },
  '🔐 Better-Auth initialized'
);

// Extended request interface for tracking
interface RequestWithTracking extends Request {
  _timer?: { end: () => number };
  _requestId?: string;
}

// Rate limiters. Bucket state lives in Redis so horizontally-scaled
// backend instances share fairness.
const globalLimiter = createStandardLimiter(redisConnection, 300);
const strictLimiter = createStrictLimiter(redisConnection, 60);
// WebSocket connection limiter: max 30 auth attempts per minute per IP.
// Prevents brute-forcing auth tokens over the ws endpoint, which bypasses
// the HTTP limiters above.
const wsAuthLimiter = createStrictLimiter(redisConnection, 30);

const app = new Elysia()
  .onBeforeHandle(({ request, set }) => {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const timer = createTimer();

    startConnectionTracking(requestId);

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
          userAgent: request.headers.get('user-agent'),
          contentType: request.headers.get('content-type'),
          origin: request.headers.get('origin'),
        },
        '📨 HTTP Request received'
      );
    }

    (request as RequestWithTracking)._timer = timer;
    (request as RequestWithTracking)._requestId = requestId;
  })
  .onBeforeHandle(async ({ request, set }) => {
    const res = await globalLimiter.tryConsume(request);
    if ('ok' in res && res.ok) return;
    set.status = 429;
    set.headers = set.headers || {};
    set.headers['Retry-After'] = String(res.retryAfterSec);
    return {
      error: 'Too Many Requests',
      message: 'Global rate limit exceeded',
      retryAfterSec: res.retryAfterSec,
    };
  })
  .onAfterHandle(({ request, response, set }) => {
    const trackedRequest = request as RequestWithTracking;
    const timer = trackedRequest._timer;
    const requestId = trackedRequest._requestId;
    const duration = timer ? timer.end() : undefined;

    if (requestId) {
      endConnectionTracking(requestId);
    }

    const url = new URL(request.url);
    const isHealthCheck = url.pathname === '/health';
    const shouldSkipLogging = isHealthCheck || request.method === 'OPTIONS';

    if (!shouldSkipLogging) {
      const statusCode =
        typeof set.status === 'number'
          ? set.status
          : set.status
            ? parseInt(set.status.toString(), 10)
            : 200;
      const isError = statusCode >= 400;

      const logData = {
        requestId,
        method: request.method,
        url: sanitizeUrl(request.url),
        statusCode,
        duration: duration ? `${duration}ms` : undefined,
        contentType: set.headers?.['content-type'],
      };

      if (isError) {
        logger.warn(logData, `⚠️ HTTP Response sent with error status: ${statusCode}`);
      } else {
        logger.info(logData, '✅ HTTP Response sent successfully');
      }
    }

    return response;
  })
  .onError(({ error, request, set }) => {
    const trackedRequest = request as RequestWithTracking;
    const requestId = trackedRequest._requestId;
    const timer = trackedRequest._timer;
    const duration = timer ? timer.end() : undefined;

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error(
      {
        requestId,
        method: request.method,
        url: sanitizeUrl(request.url),
        duration: duration ? `${duration}ms` : undefined,
        error: {
          name: errorName,
          message: errorMessage,
          stack: errorStack,
        },
      },
      `💥 HTTP Request failed: ${errorMessage}`
    );

    // Mirror the unhandled error to Sentry so ops has a stack trace even
    // when the user's browser only sees `{error, requestId}`.
    sentryCapture(error, {
      requestId: requestId || 'unknown',
      method: request.method,
      url: sanitizeUrl(request.url),
    });

    set.status = 500;

    return {
      error: 'Internal Server Error',
      message: errorMessage,
      requestId,
    };
  })
  .use(
    cors({
      // env.FRONTEND_URL is validated at startup: required + https in production.
      origin: env.FRONTEND_URL,
      credentials: true,
      allowedHeaders: ['Authorization', 'Content-Type'],
    })
  )
  .onAfterHandle(({ set }) => {
    set.headers = set.headers || {};
    set.headers['X-Content-Type-Options'] = 'nosniff';
    set.headers['X-Frame-Options'] = 'DENY';
    set.headers['X-XSS-Protection'] = '1; mode=block';
    set.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
    set.headers['Content-Security-Policy'] = "default-src 'none'";
    if (process.env.NODE_ENV === 'production') {
      set.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains; preload';
    }
  })
  .use(
    trpc(appRouter, {
      createContext,
      endpoint: '/trpc',
    })
  );

registerAdminJobsRoutes(app);

app
  .get('/', () => ({ status: 'ok', service: 'scani-backend' }))
  // Better-Auth HTTP handler at /api/auth/*. The frontend hits
  // /api/auth/sign-in/magic-link, /api/auth/get-session, etc.
  // Elysia has already consumed the original request body stream, so we
  // rebuild the Request from the parsed body before handing it off.
  .all('/api/auth/*', async ({ request, body, headers }) => {
    const cloneHeaders = new Headers();
    for (const [k, v] of Object.entries(headers ?? {})) {
      if (typeof v === 'string') cloneHeaders.set(k, v);
    }
    const init: RequestInit = {
      method: request.method,
      headers: cloneHeaders,
    };
    if (request.method !== 'GET' && request.method !== 'HEAD' && body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (!cloneHeaders.has('content-type')) {
        cloneHeaders.set('content-type', 'application/json');
      }
    }
    const cloned = new Request(request.url, init);
    return betterAuthInstance.handler(cloned);
  })
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
  .get('/health/db', async ({ set }: { set: { status: number } }) => {
    try {
      const startTime = Date.now();
      await db.execute(sql`SELECT 1 as health_check`);
      const queryTime = Date.now() - startTime;

      const connectionStats = getConnectionStats();
      const activeConnections = await getActiveConnectionsCount();
      const monitoringStats = getConnectionMonitoringStats();

      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: {
          connected: true,
          queryTime: `${queryTime}ms`,
          poolConfig: connectionStats,
          activeConnections,
          monitoring: monitoringStats,
        },
      };
    } catch (error) {
      set.status = 503;
      logger.error({ error }, '❌ Database health check failed');
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Database connection failed',
        timestamp: new Date().toISOString(),
      };
    }
  })
  .get('/health/ws', ({ set }: { set: { status: number } }) => {
    try {
      const realTimeUpdatesService = Container.get(RealTimeUpdatesService);
      const stats = realTimeUpdatesService.getStats();
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        websocket: stats,
      };
    } catch (error) {
      set.status = 503;
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      };
    }
  })
  // Deep health: everything the three user flows depend on. Returns 200 iff
  // DB + Redis + R2 + AI are all reachable; 503 with a per-check breakdown
  // otherwise. Used by the deploy-time smoke test to catch silent breakage
  // before traffic hits the new machine.
  .get('/health/deep', async ({ set }: { set: { status: number } }) => {
    const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};

    try {
      const t0 = performance.now();
      await db.execute(sql`SELECT 1`);
      checks.db = { ok: true, latencyMs: Math.round(performance.now() - t0) };
    } catch (err) {
      checks.db = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const t0 = performance.now();
      const reply = await redisConnection.ping();
      checks.redis = {
        ok: reply === 'PONG',
        latencyMs: Math.round(performance.now() - t0),
        ...(reply !== 'PONG' ? { error: `unexpected reply ${reply}` } : {}),
      };
    } catch (err) {
      checks.redis = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      // In cloud mode R2 credentials live on the data-provider, not here.
      // Proxy the check through `${SCANI_CLOUD_URL}/health/r2` so a real
      // storage outage shows up as `r2.ok=false` instead of being masked
      // by a hard-coded ok. Otherwise run the legacy in-process HEAD probe.
      if (env.SCANI_CLOUD_URL) {
        const t0 = performance.now();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3_000);
        try {
          const res = await fetch(`${env.SCANI_CLOUD_URL.replace(/\/$/, '')}/health/r2`, {
            signal: ctrl.signal,
            headers: { accept: 'application/json' },
          });
          const latencyMs = Math.round(performance.now() - t0);
          if (res.ok) {
            const upstream = (await res.json().catch(() => ({}))) as {
              ok?: boolean;
              latencyMs?: number;
              error?: string;
            };
            checks.r2 = upstream.ok
              ? { ok: true, latencyMs: upstream.latencyMs ?? latencyMs }
              : { ok: false, error: upstream.error ?? 'data-provider reported r2 unhealthy' };
          } else {
            checks.r2 = { ok: false, error: `data-provider /health/r2 returned ${res.status}` };
          }
        } finally {
          clearTimeout(timer);
        }
      } else {
        const { healthCheck: r2HealthCheck } = await import('@scani/storage');
        checks.r2 = await r2HealthCheck();
      }
    } catch (err) {
      checks.r2 = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      // Use the public `getProviderStatus()` API exposed by AIService —
      // the previous `aiProviderManager` private-field dig broke when
      // the refactor split AIService into separate provider / CSV /
      // screenshot services, and the private member was silently
      // renamed. Public status is the stable contract.
      const { AIService } = await import('@scani/domain/services');
      const ai = Container.get(AIService);
      const status = ai.getProviderStatus();
      checks.ai = {
        ok: status.hasAvailableProvider,
        ...(status.hasAvailableProvider ? {} : { error: 'no AI provider configured' }),
      };
    } catch (err) {
      checks.ai = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    if (!allOk) set.status = 503;
    return {
      status: allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
    };
  })
  .ws('/', {
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WebSocket types
    open: async (ws: any) => {
      const connectionId = crypto.randomUUID();
      const connectionLogger = wsLogger.child({ connectionId });

      // Rate-limit WS auth attempts. The limiter keys by forwarded-for headers
      // exactly like the HTTP limiter, so per-IP caps carry over across both.
      const headers = new Headers();
      const rawHeaders = ws.data.headers as Record<string, string> | undefined;
      if (rawHeaders) {
        for (const [k, v] of Object.entries(rawHeaders)) {
          try {
            headers.set(k, v);
          } catch {
            // ignore invalid header names
          }
        }
      }
      const wsPseudoRequest = new Request('http://ws.internal/', {
        method: 'GET',
        headers,
      });
      const limit = await wsAuthLimiter.tryConsume(wsPseudoRequest);
      if ('ok' in limit && !limit.ok) {
        connectionLogger.warn(
          { retryAfterSec: limit.retryAfterSec },
          'WebSocket auth rate limit exceeded — closing connection'
        );
        ws.close(4429, 'Too Many Requests');
        return;
      }

      let authenticatedUserId: string | null = null;
      try {
        // Session cookie is forwarded in the WS handshake headers
        // (cookie: better-auth.session_token=...) when the frontend
        // opens the socket. Validate it server-side.
        const result = await betterAuthInstance.api.getSession({ headers });
        if (!result?.user) {
          connectionLogger.warn('No valid Better-Auth session cookie');
          ws.close(4401, 'Unauthorized');
          return;
        }
        authenticatedUserId = result.user.id;
      } catch (err) {
        connectionLogger.error({ error: err }, 'Auth failure');
        ws.close(1011, 'Auth failure');
        return;
      }

      connectionLogger.info({ userId: authenticatedUserId }, '🔗 WebSocket client connected');

      ws.data.connectionId = connectionId;
      ws.data.userId = authenticatedUserId;
      ws.data.connectedAt = Date.now();

      const realTimeUpdatesService = Container.get(RealTimeUpdatesService);
      realTimeUpdatesService.registerConnection({ userId: authenticatedUserId, connectionId });
      ws.subscribe(`user:${authenticatedUserId}`);
      ws.send(
        JSON.stringify({
          type: 'connected',
          connectionId,
          subscriptions: ['institution', 'account', 'holding', 'token'],
          timestamp: new Date().toISOString(),
        })
      );
    },
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WebSocket types
    message: (ws: any, message: any) => {
      if (ws.data.connectionId) {
        const connectionLogger = wsLogger.child({ connectionId: ws.data.connectionId });
        connectionLogger.debug({ message }, '📨 WebSocket message received');
        const realTimeUpdatesService = Container.get(RealTimeUpdatesService);
        realTimeUpdatesService.handleMessage(ws.data.connectionId, message);
      }
    },
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WebSocket types
    close: (ws: any, code: any, reason: any) => {
      if (ws.data?.connectionId) {
        const connectionLogger = wsLogger.child({ connectionId: ws.data.connectionId });
        connectionLogger.info({ code, reason }, '🔚 WebSocket client disconnected');
        const realTimeUpdatesService = Container.get(RealTimeUpdatesService);
        realTimeUpdatesService.handleDisconnection(ws.data.connectionId);
      }
    },
  })
  .onBeforeHandle(async ({ request, set }) => {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/trpc' && request.method === 'POST') {
        const res = await strictLimiter.tryConsume(request);
        if ('ok' in res && res.ok) return;
        set.status = 429;
        set.headers = set.headers || {};
        set.headers['Retry-After'] = String(res.retryAfterSec);
        return {
          error: 'Too Many Requests',
          message: 'tRPC route rate limit exceeded',
          retryAfterSec: res.retryAfterSec,
        };
      }
    } catch {
      set.status = 400;
      return { error: 'Bad Request', message: 'Invalid request URL' };
    }
  });

wsLogger.info({ port: PORT, host: HOST }, '🔌 WebSocket endpoint configured');

const server = app.listen(PORT, () => {
  logger.info(
    {
      httpUrl: `http://${HOST}:${PORT}`,
      wsUrl: `ws://${HOST}:${PORT}`,
      environment: process.env.NODE_ENV || 'development',
    },
    '🎉 Scani Backend Server started successfully'
  );
});

const realTimeUpdatesService = Container.get(RealTimeUpdatesService);
realTimeUpdatesService.setElysiaApp(app);
realTimeUpdatesService.initialize();

// Cross-instance WS pub/sub. One connection pair: the shared
// `redisConnection` is reused for publishing; a duplicated connection is
// used for the subscriber because ioredis cannot multiplex pub/sub and
// regular commands on the same socket.
realTimeUpdatesService.configureRedisPubSub(redisConnection, redisConnection.duplicate());

import { client as pgClient } from '@scani/db/connection';
import { PricingService } from '@scani/domain/services';

// Pre-warm the currency-conversion cache in the background. Errors here are
// NOT fatal, but the promise MUST be `.catch`-ed so Node's
// unhandledRejection handler (which we install below) doesn't crash the
// process during startup.
void (async () => {
  try {
    const pricingService = Container.get(PricingService);
    await pricingService.preWarmCurrencyConversionCache();
    logger.info({}, '💰 Currency conversion cache pre-warmed');
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      '⚠️ Failed to pre-warm currency cache - will fetch on demand'
    );
  }
})().catch((error) => {
  // Defense in depth: if the async IIFE itself rejects (shouldn't, because we
  // catch inside), surface it without crashing.
  logger.error({ error }, 'Unexpected rejection from pre-warm task');
});

// Graceful shutdown: drain in-flight requests (bounded) and close the PG pool
// before exiting. Prevents torn transactions and leaked connections on
// Render redeploys.
const SHUTDOWN_HARD_CAP_MS = 15_000;
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
    logger.info({}, 'HTTP server stopped accepting new connections');

    // Close the PG pool so idle connections don't linger as zombies.
    try {
      // postgres.js accepts `{ timeout: <seconds> }` — forces close after the
      // grace window expires.
      await pgClient.end({ timeout: 10 });
      logger.info({}, 'PostgreSQL pool closed');
    } catch (err) {
      logger.error({ err }, 'Error closing PG pool during shutdown');
    }

    // Close the BullMQ queue + its Redis connection (if configured).
    try {
      await closeQueue();
      if (redisConnection) {
        await redisConnection.quit();
      }
    } catch (err) {
      logger.error({ err }, 'Error closing BullMQ/Redis during shutdown');
    }

    // Flush Sentry before exit so the shutdown-triggering error (if any)
    // makes it to the dashboard. 2s is plenty over Fly's private net.
    await flushSentry(2000);

    logger.info({}, '🏁 Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during graceful shutdown');
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

process.on('unhandledRejection', (reason, promise) => {
  logger.fatal(
    { reason, promise: promise.toString() },
    '💀 Unhandled Promise Rejection - shutting down'
  );
  process.exit(1);
});

export type { AppRouter } from './presentation/router';
