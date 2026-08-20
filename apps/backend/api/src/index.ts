import 'reflect-metadata';
// CRITICAL: Validate env vars BEFORE importing anything that reads them.
// loadEnv() will process.exit(1) with a clear error list on misconfiguration.
import { loadEnv } from './config/env';

const env = loadEnv();

import { cors } from '@elysiajs/cors';
import { trpc } from '@elysiajs/trpc';
import { loadCloudClientConfig } from '@scani/cloud-client';
import { DataProviderHealthMonitor } from '@scani/cloud-client/health-monitor';
import { probeDataProvider } from '@scani/cloud-client/health-probe';
import { getNodeEnv, isNodeEnvProduction } from '@scani/config';
import { createComponentLogger, createTimer, logger, sanitizeUrl } from '@scani/logging';
import { flushSentry, initSentry, captureException as sentryCapture } from '@scani/logging/sentry';
import { setSharedRedis } from '@scani/rate-limiter';
import { LANGUAGE_HEADER } from '@scani/shared';

// Sentry is the first thing we wire up so any subsequent boot-time failure
// reaches the error tracker instead of being lost to stdout.
initSentry({ component: 'backend', release: env.SENTRY_RELEASE });

const wsLogger = createComponentLogger('websocket');

// Probe the data-provider at boot. The previous version exited on
// failure; the 2026-05-09 outage taught us that a transient
// dependency unreachability turns into a hard-down when the api
// crashes on a rolling deploy of data-provider. We now warn + log,
// leaving `app.listen()` to proceed; cloud-mode tRPC calls will
// surface their own 503 if data-provider is still down at request
// time.
//
// The result seeds the background monitor rather than alerting here.
// An api that boots while the data-provider is mid-deploy is the same
// transient the monitor exists to ride out, so it goes through the same
// consecutive-failure threshold instead of paging immediately.
const dataProviderReachable = await (async () => {
  const probe = await probeDataProvider();
  if (probe.ok) {
    if (probe.url) {
      logger.info({ url: probe.url, attempts: probe.attempts }, '☁️  Data-provider reachable');
    }
    return true;
  }
  logger.warn(
    { url: probe.url, attempts: probe.attempts, error: probe.error, status: probe.status },
    `⚠️  Data-provider unreachable at ${probe.url} after ${probe.attempts} attempt(s): ${probe.error ?? `HTTP ${probe.status}`}`
  );
  return false;
})();

// CRITICAL: Initialize container BEFORE importing any routers
// This must happen before any module that calls Container.get()
import { assertQueueBindings, QueueClient } from '@scani/queue';
import {
  createSessionRevokeLimiter,
  createSignupLimiter,
  createStandardLimiter,
  createStrictLimiter,
  observeRedisReachability,
  pingWithin,
  type StrandReport,
  startRedisStrandWatchdog,
  strandedRedisError,
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
  checkSchemaDrift,
  db,
  describeSchemaDrift,
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
import { buildCorsOrigins, buildTrustedOrigins } from './config/browser-origins';
import { initializeContainer } from './config/container';
import { isLivenessProbe } from './lib/liveness';
import { registerAdminDataRoutes } from './presentation/http/admin-data';
import { registerAdminJobsRoutes } from './presentation/http/admin-jobs';
import { registerUnsubscribeRoutes } from './presentation/http/unsubscribe';
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
// SC-225. Without an `error` listener ioredis falls through to
// `console.error('[ioredis] Unhandled error event:')` (Redis.js:532) — that
// branch runs ONLY when nobody is listening, so the two-second spam in
// production was ioredis reporting exactly this absence. Listening silences it
// and, more usefully, turns it into state `/health/deep` can report: how long,
// how many attempts, and whether the failure is name resolution (which does
// not self-heal) or connection (which does).
/**
 * How long `/health/deep` waits for a Redis PING before calling it unreachable.
 *
 * Sized against ioredis's own retry cadence rather than against a latency
 * budget: the default `retryStrategy` tops out at one attempt every 2000ms, so
 * a ping unanswered for a full retry interval is not waiting on a slow Redis,
 * it is waiting on one that is not there. Healthy production latency here is
 * 1ms (SC-294).
 */
const REDIS_PING_TIMEOUT_MS = 2_000;

const redisReachability = observeRedisReachability(redisConnection, logger, 'redis');
// SC-327. The tracker above only records the strand; this is what makes
// somebody find out about it. Nothing was watching outside a deploy, so an OOM
// restart or a Fly host migration of scani-worker — which is where Redis lives
// — took the api down for ~20 minutes on 2026-08-16 while `/health` answered
// 200 throughout, because `/health` is shallow BY DESIGN (fly.toml gates
// traffic on it). This machine watches its own connection instead of relying
// on anything fetching the load-balanced hostname, which would see one machine
// of the pair at random.
startRedisStrandWatchdog({
  reachability: redisReachability,
  redis: redisConnection,
  pingTimeoutMs: REDIS_PING_TIMEOUT_MS,
  onStranded: (report: StrandReport) => {
    const err = strandedRedisError(report);
    logger.error(
      {
        unreachableForMs: report.unreachableForMs,
        consecutiveErrors: report.consecutiveErrors,
        nameResolutionFailure: report.nameResolutionFailure,
        lastError: report.lastError,
        pingError: report.pingError,
      },
      err.message
    );
    sentryCapture(err, {
      component: 'backend',
      redis_name_resolution_failure: String(report.nameResolutionFailure),
    });
  },
});
Container.get(QueueClient).configure({ connection: redisConnection });
// SC-298. Without a registered enqueue mirror every job this api accepts runs
// with no `user_jobs` row and nothing is logged at any level. The mirror
// registers as a decorator side-effect of `import '@scani/jobs'`, so the
// invariant rested entirely on that import and the CRITICAL comment beside it.
// This is the executable statement of the requirement.
//
// **Measured, so the comment does not overclaim**: deleting the bare
// `import '@scani/jobs'` above does NOT trip this — the routers import named
// symbols from the same module, so it loads regardless, and the api boots
// logging `Queue bindings verified`. What this catches is the registration
// genuinely being absent, not one import line being removed. The bare import
// stays because it is the only thing ordering registration ahead of a future
// module-level resolve; this is a second, different guard, not a replacement.
//
// Only what this process needs — the api enqueues; it runs no scheduled
// processors, so the lock and heartbeat writer are the worker's to require.
assertQueueBindings(['enqueue-mirror']);
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
const browserOriginOptions = { isProduction: isNodeEnvProduction() };
const trustedOrigins = buildTrustedOrigins(env.FRONTEND_URL, browserOriginOptions);
const betterAuthInstance = createBetterAuth({
  baseURL: env.BACKEND_URL,
  secret: env.BETTER_AUTH_SECRET,
  cookieDomain: env.COOKIE_DOMAIN,
  trustedOrigins,
  screenshotBotSecret: env.SCREENSHOT_BOT_SECRET,
});
setBetterAuthForContext(betterAuthInstance);
logger.info(
  {
    backendURL: env.BACKEND_URL,
    trustedOrigins,
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
    // The liveness probe carries NO dependency, including through middleware
    // (SC-225). `fly.toml` gates traffic on `/health`, and on 2026-08-15 this
    // very limiter held it: `tryConsume` awaits INCRBY on the shared ioredis
    // connection, the worker deploy replaced the machine Redis lives in, and
    // `maxRetriesPerRequest: null` means a queued command is never rejected.
    // The check did not get a 503, it got nothing — both machines went
    // critical and the app left the load balancer for 14 minutes, over a
    // dependency a static handler never touches.
    //
    // The limiter is now bounded and degrades on its own, so this is defence
    // in depth rather than the fix. It is still worth having: "can this
    // process serve" must be answerable by this process alone. The three
    // probes stay distinct — `/health/deep` and `/readyz` are the ones that
    // SHOULD fail when Redis is unreachable, and they still do.
    //
    // The cost is that `/health` is unmetered. It is a static handler with no
    // I/O, and Fly's own per-machine concurrency ceiling (soft 80 / hard 120)
    // still applies, so the exposure is a cheap 200 rather than an
    // amplification.
    if (isLivenessProbe(request)) return;
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
  .onError(({ code, error, request, set }) => {
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

    // Unmatched-route 404s are almost entirely bot vulnerability scans
    // (/index.php?option=com_sppagebuilder, //xmlrpc.php?rsd, …). They're
    // not server errors: the old handler mislabelled them as 500 and paged
    // Sentry on every hit, burying real errors. Answer a plain 404 and skip
    // the capture.
    if (code === 'NOT_FOUND') {
      set.status = 404;
      return { error: 'Not Found', requestId };
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
      // In dev this also allows loopback on any port — see browser-origins.ts.
      origin: buildCorsOrigins(env.FRONTEND_URL, browserOriginOptions),
      credentials: true,
      // `LANGUAGE_HEADER` is what the auth client puts the reader's interface
      // language on (SC-412). A custom header makes the sign-in POST
      // preflighted, so omitting it here does not degrade the letter to
      // English — it fails the request outright.
      allowedHeaders: ['Authorization', 'Content-Type', LANGUAGE_HEADER],
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
registerAdminDataRoutes(app, redisConnection);
// One-click, no-login digest opt-out (SC-460). Public by design.
registerUnsubscribeRoutes(app);

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
  // Readiness probe — `docker-compose.prod.yml`'s healthcheck for the api
  // container. Pings DB + Redis and checks that the schema has been
  // migrated. No upstream calls, p99 < 100ms in the happy path.
  //
  // NOT used by Fly's load balancer, despite what this comment claimed until
  // SC-225. `apps/backend/api/fly.toml` configures exactly one check and it is
  // `GET /health` — the static handler above. The distinction is the whole
  // ticket: a probe that fails when Redis is unreachable is correct here and
  // catastrophic there, and believing the LB already gated on a dependency
  // probe is what makes the outage look impossible. `tests/lib/liveness.test.ts`
  // reads the toml so this cannot drift again.
  //
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

    // SC-480. `SELECT 1` above proves a connection, and proves nothing about
    // the schema on the other end of it: it names no column of any table the
    // deploy just changed, so a code/schema mismatch is invisible to it BY
    // CONSTRUCTION. On 2026-08-20 a deploy that omitted the `migrate` target
    // shipped an api selecting `users.cost_basis_method` against a database
    // without it; this endpoint answered 200, the deploy smoke passed, and
    // sign-in — the one flow that reads `users` by email — failed for six
    // hours. This is the check that would have failed instead.
    //
    // Only run when the connection is up: against an unreachable database it
    // reports every table missing, which reads as catastrophic drift and is
    // really just `checks.db` again, said louder.
    if (checks.db.ok) {
      try {
        const drift = await checkSchemaDrift();
        checks.schema = drift.ok
          ? { ok: true, latencyMs: drift.latencyMs }
          : { ok: false, latencyMs: drift.latencyMs, error: describeSchemaDrift(drift) };
      } catch (err) {
        checks.schema = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const tRedis = performance.now();
    try {
      // BOUNDED, and that bound is the whole point (SC-294).
      //
      // ioredis queues a command issued while the connection is down and
      // resolves it whenever the connection comes back — which, for a machine
      // whose Redis host does not resolve, is never. So this `await` used to
      // hang until Fly's proxy gave up at ~31s and returned a 502 with no
      // body at all.
      //
      // That is why `redisReachability` — the field added directly below,
      // whose entire job is to say WHICH kind of unreachable this is — had
      // never once been read during an occurrence. The deploy smoke fetches
      // its diagnostic body with `curl --max-time 10`, so it got an empty
      // string and reported `exit=28`. The endpoint carrying the diagnosis
      // could not deliver it during the exact failure it describes.
      //
      // Two seconds is chosen against ioredis's own retry cadence: the
      // default `retryStrategy` tops out at one attempt every 2000ms, so a
      // ping that has not been answered within one full retry interval is not
      // waiting on a slow Redis, it is waiting on one that is not there.
      // Healthy production latency on this check is 1ms.
      const reply = await pingWithin(redisConnection, REDIS_PING_TIMEOUT_MS);
      checks.redis = {
        ok: reply === 'PONG',
        latencyMs: Math.round(performance.now() - tRedis),
        ...(reply !== 'PONG' ? { error: `unexpected reply ${reply}` } : {}),
      };
    } catch (err) {
      checks.redis = {
        ok: false,
        latencyMs: Math.round(performance.now() - tRedis),
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // SC-225. `ping()` above answers "can I reach Redis right now"; this
    // answers "how long have I not been able to, and is it the kind that
    // recovers". One machine sat on an unresolvable name for three hours
    // while the probe simply said `ok: false`, which reads the same as a
    // worker deploy in progress. `nameResolutionFailure` is the difference:
    // ioredis re-resolves every ~2s forever and will keep getting the same
    // answer, so that one needs the machine replaced rather than waiting.
    //
    // Gated on the ping deliberately. ioredis emits `error` for things that do
    // NOT close the socket, and those are never followed by a `ready` to clear
    // the tracker — so a latched tracker on its own would 503 this endpoint
    // forever against a perfectly healthy Redis. The ping is the authority on
    // "can I reach it now"; the tracker only ever explains "for how long, and
    // is it the kind that recovers".
    const reachability = redisReachability.current();
    if (reachability.state === 'unreachable' && checks.redis?.ok !== true) {
      checks.redisReachability = {
        ok: false,
        error: reachability.nameResolutionFailure
          ? `host does not resolve from this machine for ${reachability.unreachableForMs}ms (${reachability.consecutiveErrors} attempts) — will not self-heal`
          : `unreachable for ${reachability.unreachableForMs}ms (${reachability.consecutiveErrors} attempts): ${reachability.lastError}`,
      };
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
// unavailability at boot doesn't latch the api into "degraded" forever.
// The threshold — not the probe — is what stops a deploy cutover paging
// us; see `DataProviderHealthMonitor` for the full reasoning and for the
// Sentry issue that motivated it.
new DataProviderHealthMonitor({
  initiallyReachable: dataProviderReachable,
  onCycleFailed: ({ url, error, status, consecutiveFailures }) => {
    logger.warn(
      { url, error, status, consecutiveFailures },
      '⚠️  Data-provider unreachable (in re-probe)'
    );
  },
  onOutage: ({ error, status, consecutiveFailures }) => {
    sentryCapture(
      new Error(
        `data-provider unreachable for ${consecutiveFailures} consecutive probes: ${error ?? status}`
      ),
      { component: 'api', kind: 'data-provider-reprobe-failed' }
    );
  },
  onRecovered: ({ url, failedCycles }) => {
    logger.info({ url, failedCycles }, '☁️  Data-provider reachable (recovered)');
  },
}).start();

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
