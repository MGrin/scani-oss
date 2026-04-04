import 'reflect-metadata';
import { cors } from '@elysiajs/cors';
import { trpc } from '@elysiajs/trpc';
import { supabase } from '@scani/core/lib/supabase';
import { createTimer, logger, wsLogger } from '@scani/core/utils/logger';
import { IntegrationManager } from '@scani/integrations';
import { sql } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { Container } from 'typedi';
// CRITICAL: Initialize container BEFORE importing any routers
// This must happen before any module that calls Container.get()
import { initializeContainer } from './config/container';
import { RealTimeUpdatesService } from './infrastructure/websocket/RealTimeUpdatesService';
import { createStandardLimiter, createStrictLimiter } from './presentation/middleware/rate-limit';
import { createContext } from './presentation/trpc';

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
} from '@scani/core/database';
// Import router AFTER container is initialized
import { appRouter } from './presentation/router';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const HOST = process.env.HOST ?? 'localhost';

// Log startup information
logger.info(
  {
    port: PORT,
    host: HOST,
    nodeEnv: process.env.NODE_ENV || 'development',
    frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  },
  '🚀 Starting Scani Backend Server'
);

// Extended request interface for tracking
interface RequestWithTracking extends Request {
  _timer?: { end: () => number };
  _requestId?: string;
}

// Create limiters
const globalLimiter = createStandardLimiter(300, 500);
const strictLimiter = createStrictLimiter(60, 90);

const app = new Elysia()
  .onBeforeHandle(({ request, set }) => {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const timer = createTimer();

    startConnectionTracking(requestId);

    set.headers = set.headers || {};
    set.headers['x-request-id'] = requestId;

    const isHealthCheck = url.pathname === '/health';

    if (!isHealthCheck) {
      logger.info(
        {
          requestId,
          method: request.method,
          url: request.url,
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
    const res = globalLimiter.tryConsume(request);
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

    if (!isHealthCheck) {
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
        url: request.url,
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
        url: request.url,
        duration: duration ? `${duration}ms` : undefined,
        error: {
          name: errorName,
          message: errorMessage,
          stack: errorStack,
        },
      },
      `💥 HTTP Request failed: ${errorMessage}`
    );

    set.status = 500;

    return {
      error: 'Internal Server Error',
      message: errorMessage,
      requestId,
    };
  })
  .use(
    cors({
      origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
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

app
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
  // biome-ignore lint/suspicious/noExplicitAny: Elysia WebSocket types
  .ws('/', {
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WebSocket types
    open: async (ws: any) => {
      const connectionId = crypto.randomUUID();
      const connectionLogger = wsLogger.child({ connectionId });

      let authenticatedUserId: string | null = null;
      try {
        const query = ws.data.query as Record<string, string> | undefined;
        const token = query?.token;
        if (!token) {
          connectionLogger.warn('No auth token provided');
          ws.close(4401, 'Unauthorized');
          return;
        }
        const { data, error } = await supabase.auth.getUser(token);
        if (error || !data?.user) {
          connectionLogger.warn({ error }, 'Invalid auth token');
          ws.close(4401, 'Unauthorized');
          return;
        }
        authenticatedUserId = data.user.id;
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
  .onBeforeHandle(({ request, set }) => {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/trpc' && request.method === 'POST') {
        const res = strictLimiter.tryConsume(request);
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

import { PricingService } from '@scani/core/services';

(async () => {
  try {
    const pricingService = Container.get(PricingService);
    await pricingService.preWarmCurrencyConversionCache();
    logger.info({}, '💰 Currency conversion cache pre-warmed');
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      '⚠️ Failed to pre-warm currency cache - will fetch on demand'
    );
  }
})();

const gracefulShutdown = (signal: string) => {
  logger.info({ signal }, '🛑 Graceful shutdown initiated');
  server.stop();
  logger.info({}, '🏁 Graceful shutdown completed');
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

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
