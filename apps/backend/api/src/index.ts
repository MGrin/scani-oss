import 'reflect-metadata';
// CRITICAL: Validate env vars BEFORE importing anything that reads them.
// loadEnv() will process.exit(1) with a clear error list on misconfiguration.
import { loadEnv } from './config/env';

const env = loadEnv();

import { cors } from '@elysiajs/cors';
import { trpc } from '@elysiajs/trpc';
import { loadCloudClientConfig } from '@scani/cloud-client';
import { probeDataProvider } from '@scani/cloud-client/health-probe';
import { getNodeEnv, isNodeEnvProduction } from '@scani/config';
import { createComponentLogger, createTimer, logger, sanitizeUrl } from '@scani/logging';
import { flushSentry, initSentry, captureException as sentryCapture } from '@scani/logging/sentry';
import { setSharedRedis } from '@scani/rate-limiter';

// Sentry is the first thing we wire up so any subsequent boot-time failure
// reaches the error tracker instead of being lost to stdout.
initSentry({ component: 'backend', release: env.SENTRY_RELEASE });

const wsLogger = createComponentLogger('websocket');

// Probe the data-provider at boot. The previous version exited on
// failure; the 2026-05-09 outage taught us that a transient
// dependency unreachability turns into a hard-down when the api
// crashes on a rolling deploy of data-provider. We now warn + log +
// Sentry, leaving `app.listen()` to proceed; cloud-mode tRPC calls
// will surface their own 503 if data-provider is still down at
// request time. A background re-probe updates the flag so
// recovery is visible.
let dataProviderReachable = true;
{
  const probe = await probeDataProvider();
  if (!probe.ok) {
    dataProviderReachable = false;
    const message = `Data-provider unreachable at ${probe.url} after ${probe.attempts} attempt(s): ${probe.error ?? `HTTP ${probe.status}`}`;
    logger.warn({ url: probe.url, attempts: probe.attempts }, `⚠️  ${message}`);
    // Sentry import is staged later in the boot chain; hold capture
    // for now and surface via the periodic re-probe below.
  } else if (probe.url) {
    logger.info({ url: probe.url, attempts: probe.attempts }, '☁️  Data-provider reachable');
  }
}

// CRITICAL: Initialize container BEFORE importing any routers
// This must happen before any module that calls Container.get()
import { QueueClient } from '@scani/queue';
import {
  createSessionRevokeLimiter,
  createSignupLimiter,
  createStandardLimiter,
  createStrictLimiter,
} from '@scani/rate-limiter';
import { RedisRealtimeUpdatesService, WebSocketRealtimeUpdatesService } from '@scani/realtime';
import { StorageService } from '@scani/storage';
import { sql } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { Redis } from 'ioredis';
import { Container } from 'typedi';
// CRITICAL: side-effect import registers the @scani/jobs @Service classes
// (UserJobEnqueueMirror, UserJobLifecycleMirror, PostgresJobLock) before
// any Container.get against the framework abstracts.
import '@scani/jobs';
import {
  awaitSchemaReady,
  db,
  endConnectionTracking,
  getActiveConnectionsCount,
  getConnectionMonitoringStats,
  getConnectionStats,
  startConnectionTracking,
} from '@scani/db';
import { buildProviderRegistry } from '@scani/providers/core/boot';
import { aiOpenAIFactory } from '@scani/providers/providers/ai-openai';
import { aiStubFactory } from '@scani/providers/providers/ai-stub';
import { airwallexFactory } from '@scani/providers/providers/airwallex';
import { binanceFactory } from '@scani/providers/providers/binance';
import { bitcoinFactory } from '@scani/providers/providers/bitcoin';
import { bitgetFactory } from '@scani/providers/providers/bitget';
import { bitstampFactory } from '@scani/providers/providers/bitstamp';
import { bybitFactory } from '@scani/providers/providers/bybit';
import { coinbaseFactory } from '@scani/providers/providers/coinbase';
import { coingeckoFactory } from '@scani/providers/providers/coingecko';
import { defillamaFactory } from '@scani/providers/providers/defillama';
import { etherscanFactory } from '@scani/providers/providers/etherscan';
import { finnhubFactory } from '@scani/providers/providers/finnhub';
import { frankfurterFactory } from '@scani/providers/providers/frankfurter';
import { gateFactory } from '@scani/providers/providers/gate';
import { geminiFactory } from '@scani/providers/providers/gemini';
import { huobiFactory } from '@scani/providers/providers/huobi';
import { ibkrFactory } from '@scani/providers/providers/ibkr';
import { krakenFactory } from '@scani/providers/providers/kraken';
import { kucoinFactory } from '@scani/providers/providers/kucoin';
import { mexcFactory } from '@scani/providers/providers/mexc';
import { okxFactory } from '@scani/providers/providers/okx';
import { solanaFactory } from '@scani/providers/providers/solana';
import { tonFactory } from '@scani/providers/providers/ton';
import { tronFactory } from '@scani/providers/providers/tron';
import { wiseFactory } from '@scani/providers/providers/wise';
import { googleSheetsFactory } from '@scani/providers-google-sheets';
import { createBetterAuth } from './auth/better-auth';
import { initializeContainer } from './config/container';
import { registerAdminJobsRoutes } from './presentation/http/admin-jobs';
import {
  createContext,
  setBetterAuthForContext,
  setSessionRevokeLimiterForContext,
} from './presentation/trpc';

initializeContainer();

// Stand up the `@scani/providers` registry — single source of truth for
// pricing, balance, transactions, identity, and AI dispatch.
try {
  const providerRedis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });
  const built = await buildProviderRegistry({
    mode: 'direct',
    redis: providerRedis,
    env: process.env,
    providers: [
      // Pricing — public APIs.
      defillamaFactory,
      frankfurterFactory,
      coingeckoFactory,
      finnhubFactory,
      // Chain providers — public-endpoint balance + address-validator
      // dispatch for wallet imports.
      etherscanFactory,
      bitcoinFactory,
      solanaFactory,
      tronFactory,
      tonFactory,
      // CEX — user-credentialed balance fetch + credential validation.
      binanceFactory,
      coinbaseFactory,
      krakenFactory,
      bybitFactory,
      okxFactory,
      kucoinFactory,
      gateFactory,
      bitgetFactory,
      bitstampFactory,
      huobiFactory,
      mexcFactory,
      geminiFactory,
      // Brokers + fiat.
      ibkrFactory,
      wiseFactory,
      airwallexFactory,
      // AI: STUB_AI=1 registers a fixed-payload provider FIRST so the
      // e2e suite gets deterministic AI results without an OpenAI key.
      // The data-provider config schema refuses STUB_AI=1 in production,
      // so a misconfigured prod deploy crashes the data-provider at boot
      // before this branch ever fires.
      ...(process.env.STUB_AI === '1' ? [aiStubFactory] : []),
      aiOpenAIFactory,
    ],
  });
  // GoogleSheets lives in its own workspace (`@scani/providers-google-sheets`)
  // because the googleapis SDK is ~160MB on disk; keeping it out of
  // `@scani/providers` means data-provider's image doesn't carry the dep.
  // The factory needs the postgres connection (per-user sheet config), so
  // we register it here rather than in the standard providers array.
  const googleSheetsProvider = googleSheetsFactory({
    db,
    redis: providerRedis,
    rateLimiterRegistry: built.rateLimiterRegistry,
  });
  built.registry.register(googleSheetsProvider);
  logger.info({}, '✅ @scani/providers registry initialized');
} catch (error) {
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    '⚠️ Failed to initialize @scani/providers registry'
  );
  throw error;
}

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
    scaniCloudUrl: loadCloudClientConfig().SCANI_CLOUD_URL ?? '(local fallback)',
  },
  '🚀 Starting Scani Backend Server'
);

// Shared ioredis connection — powers BullMQ (enqueue jobs), the rate
// limiter (fairness across horizontally-scaled instances), and the WS
// pub/sub (real-time fan-out across instances).
const redisConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
Container.get(QueueClient).configure({ connection: redisConnection });
// Make the Redis-backed rate limiter the default for every `new
// RateLimiter(..., { namespace })` in the process. Without this call,
// limiters fall back to per-process in-memory and N backend replicas
// each get their own full upstream-API budget.
setSharedRedis(redisConnection);

// StorageService is a fallback path: when SCANI_CLOUD_URL is set, the
// cloud-client storage facade routes everything through the data-provider
// and StorageService is never instantiated. In OSS / dev mode it lazy-
// loads its config from S3_* env vars (see @scani/storage) on first call.

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
  cookieDomain: env.COOKIE_DOMAIN,
  trustedOrigins: [env.FRONTEND_URL],
  screenshotBotSecret: env.SCREENSHOT_BOT_SECRET,
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
// Per-IP signup attempt cap. Better-Auth's signup response still
// reveals "email exists" vs "new", so this limiter is the primary
// defense against account enumeration brute force.
const signupLimiter = createSignupLimiter(redisConnection, 6);
// Per-user limiter for session-revoke mutations. Threaded onto the tRPC
// context via setSessionRevokeLimiterForContext below so the sessions
// router can read it off `ctx`.
const sessionRevokeLimiter = createSessionRevokeLimiter(redisConnection, 10);
setSessionRevokeLimiterForContext(sessionRevokeLimiter);
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
  .onBeforeHandle(({ request, set }) => {
    // Reject oversized requests before the body is read into memory.
    // The largest legitimate payload is a base64-encoded statement at
    // ~4 MB (see UPLOAD_LIMITS.INLINE_DECODED_BYTES) plus tRPC envelope;
    // 16 MB is a comfortable ceiling and still bounds memory under a
    // burst of attacker requests. Without this an unauthenticated POST
    // with Content-Length: 5 GB would let the framework allocate
    // before the per-procedure zod `.max()` kicks in.
    const contentLength = request.headers.get('content-length');
    if (contentLength) {
      const len = Number.parseInt(contentLength, 10);
      if (Number.isFinite(len) && len > 16 * 1024 * 1024) {
        set.status = 413;
        return { error: 'Payload Too Large', message: `Request exceeds 16 MB cap (${len} bytes)` };
      }
    }
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

    // Mirror the cleanup in `onAfterHandle` so failed requests don't
    // leak entries in connection-monitor's `requestMetrics` Map. Every
    // unhandled error otherwise added another row to a Map that
    // shrinks only on the success path; over ~18h of idle traffic + an
    // occasional 401/500 the backend OOM-killed at the 1 GB cgroup
    // boundary (Fly machine event 2026-05-08 07:30:18, exit_code=137).
    if (requestId) {
      endConnectionTracking(requestId);
    }

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
    // `X-XSS-Protection` is dropped intentionally — the legacy IE/Chrome
    // XSS auditor was removed years ago, and the spec advice is to send
    // either nothing or `0`. CSP (`default-src 'none'`) is what actually
    // protects this JSON-only API.
    set.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
    set.headers['Permissions-Policy'] =
      'camera=(), microphone=(), geolocation=(), interest-cohort=()';
    set.headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    set.headers['Cross-Origin-Resource-Policy'] = 'same-site';
    set.headers['Content-Security-Policy'] =
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
    if (isNodeEnvProduction()) {
      set.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains; preload';
    }
  })
  .use(
    trpc(appRouter, {
      createContext,
      endpoint: '/trpc',
    })
  );

registerAdminJobsRoutes(app, redisConnection);

app
  .get('/', () => ({ status: 'ok', service: 'api' }))
  // Better-Auth HTTP handler at /api/auth/*. The frontend hits
  // /api/auth/sign-in/magic-link, /api/auth/get-session, etc.
  // Elysia has already consumed the original request body stream, so we
  // rebuild the Request from the parsed body before handing it off.
  .all('/api/auth/*', async ({ request, body, headers, set }) => {
    // Enumeration / brute-force defense. Better-Auth's signup +
    // sign-in responses distinguish "exists" from "new" / "wrong
    // password" by status code, so an attacker can probe a list of
    // emails as fast as the global limiter allows (300/min). The
    // signup-specific limiter caps at 6/hour per IP across signup +
    // sign-in + magic-link request endpoints; a real user hits the
    // page at most a handful of times per hour, so 6 is comfortable
    // headroom while raising enumeration cost ~3000×.
    const pathname = new URL(request.url).pathname;
    const isAuthAttempt =
      pathname.startsWith('/api/auth/sign-up') ||
      pathname.startsWith('/api/auth/sign-in') ||
      pathname.startsWith('/api/auth/email-otp/send-verification-otp') ||
      pathname.startsWith('/api/auth/forget-password') ||
      // change-email triggers an outbound confirmation email per call;
      // without a rate limit an attacker with any session can flood a
      // target inbox. change-password is disabled at the
      // emailAndPassword config but Better-Auth still mounts the route;
      // the limiter also covers the latent brute-force surface on the
      // current-password challenge.
      pathname.startsWith('/api/auth/change-email') ||
      pathname.startsWith('/api/auth/change-password');
    if (isAuthAttempt) {
      const res = await signupLimiter.tryConsume(request);
      if ('ok' in res && !res.ok) {
        set.status = 429;
        set.headers = set.headers || {};
        set.headers['Retry-After'] = String(res.retryAfterSec);
        return {
          error: 'Too Many Requests',
          message: 'Too many auth attempts from this IP. Try again later.',
          retryAfterSec: res.retryAfterSec,
        };
      }
    }
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
      const stats = Container.get(WebSocketRealtimeUpdatesService).getStats();
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
  // Readiness probe — used by the load balancer (and docker-compose
  // healthchecks) to decide when a fresh machine should start receiving
  // traffic. Pings DB + Redis and checks that the schema has been
  // migrated. No upstream calls, p99 < 100ms in the happy path.
  // `/health` (above) doubles as the liveness probe (process alive).
  // `/health/deep` is for deploy-time smoke tests, not for traffic routing.
  //
  // The schema check is what makes this fail-loud when the operator
  // forgets `docker compose --profile migrate run --rm migrate` on a
  // fresh prod-compose deploy. Without it, the api binds, /health
  // returns 200, but every authenticated route 500s on missing tables.
  .get('/readyz', async ({ set }: { set: { status: number } }) => {
    const checks: Record<string, { ok: boolean; latencyMs: number; error?: string }> = {};
    const dbStart = performance.now();
    try {
      await db.execute(sql`SELECT 1`);
      checks.db = { ok: true, latencyMs: Math.round(performance.now() - dbStart) };
    } catch (err) {
      checks.db = {
        ok: false,
        latencyMs: Math.round(performance.now() - dbStart),
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const redisStart = performance.now();
    try {
      const reply = await redisConnection.ping();
      checks.redis = {
        ok: reply === 'PONG',
        latencyMs: Math.round(performance.now() - redisStart),
        ...(reply !== 'PONG' ? { error: `unexpected reply ${reply}` } : {}),
      };
    } catch (err) {
      checks.redis = {
        ok: false,
        latencyMs: Math.round(performance.now() - redisStart),
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Schema readiness — verifies the canary tables exist. Short
    // poll/timeout so this probe stays cheap; if the schema's truly
    // missing the next call lands within a second.
    const schemaStart = performance.now();
    try {
      await awaitSchemaReady({ timeoutMs: 500, pollMs: 100 });
      checks.schema = { ok: true, latencyMs: Math.round(performance.now() - schemaStart) };
    } catch (err) {
      checks.schema = {
        ok: false,
        latencyMs: Math.round(performance.now() - schemaStart),
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const ok = checks.db.ok && checks.redis.ok && checks.schema.ok;
    if (!ok) set.status = 503;
    return {
      status: ok ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      checks,
    };
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
      // by a hard-coded ok. Otherwise run the in-process HEAD probe.
      const cloudUrl = loadCloudClientConfig().SCANI_CLOUD_URL;
      if (cloudUrl) {
        const t0 = performance.now();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3_000);
        try {
          const res = await fetch(`${cloudUrl.replace(/\/$/, '')}/health/r2`, {
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
        checks.r2 = await Container.get(StorageService).healthCheck();
      }
    } catch (err) {
      checks.r2 = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const status = Container.get(AIRouter).getStatus();
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

      Container.get(WebSocketRealtimeUpdatesService).registerConnection({
        userId: authenticatedUserId,
        connectionId,
      });
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
        Container.get(WebSocketRealtimeUpdatesService).handleMessage(ws.data.connectionId, message);
      }
    },
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WebSocket types
    close: (ws: any, code: any, reason: any) => {
      if (ws.data?.connectionId) {
        const connectionLogger = wsLogger.child({ connectionId: ws.data.connectionId });
        connectionLogger.info({ code, reason }, '🔚 WebSocket client disconnected');
        Container.get(WebSocketRealtimeUpdatesService).handleDisconnection(ws.data.connectionId);
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
      environment: getNodeEnv() || 'development',
    },
    '🎉 Scani Backend Server started successfully'
  );
});

// Wire the realtime stack. Two transports compose:
//  - WebSocket service owns local connections and Elysia's pub/sub topic.
//  - Redis service owns cross-instance fan-out (worker → api, api → api).
// `pipeFromRedis` bridges them: every `rt:user:*` message reaching this
// machine via Redis is forwarded to its local WS clients. Workers and
// other api instances just `broadcast()` via the Redis service; their
// payloads land here through the pipe. ioredis cannot multiplex pub/sub
// and regular commands on the same socket, hence the `.duplicate()`.
const wsRealtime = Container.get(WebSocketRealtimeUpdatesService);
wsRealtime.setElysiaApp(app);
wsRealtime.initialize();
Container.get(RedisRealtimeUpdatesService).configure(redisConnection);
wsRealtime.pipeFromRedis(redisConnection.duplicate());

// Background re-probe of the data-provider so a transient
// unavailability at boot doesn't latch the api into "degraded"
// forever. Logs + captures the first failure, then logs recovery
// once it goes green again.
{
  const REPROBE_INTERVAL_MS = 60_000;
  let everReportedDown = !dataProviderReachable;
  if (!dataProviderReachable) {
    sentryCapture(
      new Error('data-provider unreachable at boot — api running with cloud-mode degraded'),
      { component: 'api', kind: 'data-provider-boot-unreachable' }
    );
  }
  const probeTimer = setInterval(() => {
    void (async () => {
      try {
        const probe = await probeDataProvider();
        if (probe.ok) {
          if (!dataProviderReachable) {
            logger.info(
              { url: probe.url, attempts: probe.attempts },
              '☁️  Data-provider reachable (recovered)'
            );
            dataProviderReachable = true;
          }
          return;
        }
        if (dataProviderReachable) {
          logger.warn(
            { url: probe.url, error: probe.error, status: probe.status },
            '⚠️  Data-provider unreachable (in re-probe)'
          );
          if (!everReportedDown) {
            sentryCapture(
              new Error(`data-provider re-probe failed: ${probe.error ?? probe.status}`),
              {
                component: 'api',
                kind: 'data-provider-reprobe-failed',
              }
            );
            everReportedDown = true;
          }
          dataProviderReachable = false;
        }
      } catch (err) {
        logger.warn({ err }, '⚠️  Data-provider re-probe threw');
      }
    })();
  }, REPROBE_INTERVAL_MS);
  probeTimer.unref?.();
}

import { client as pgClient } from '@scani/db/connection';
import { AIRouter, PricingService } from '@scani/domain/services';

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
    // Notify connected WS clients before tearing the HTTP server down.
    // Without this every Fly redeploy looks like a network error to the
    // SPA and real-time updates stop until the user manually refreshes.
    // The broadcast fans out via Elysia's pub/sub; give it a brief beat
    // to flush over the wire before server.stop() severs the sockets.
    try {
      const { recipients } = wsRealtime.broadcastShutdown(1000);
      logger.info({ recipients }, 'Broadcast shutdown advisory to WebSocket clients');
      if (recipients > 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (err) {
      logger.warn({ err }, 'WS shutdown broadcast failed (non-fatal)');
    }

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
      await Container.get(QueueClient).close();
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
