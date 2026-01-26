import 'reflect-metadata';
import { cors } from '@elysiajs/cors';
import { trpc } from '@elysiajs/trpc';
import {
  captureException,
  close,
  flush,
  initializeSentry,
  startHttpTransaction,
} from '@scani/core/lib/sentry';
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

// Initialize Sentry for error tracking
initializeSentry();

// Import database for health checks
import { db, getActiveConnectionsCount, getConnectionStats } from '@scani/core/database';

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

// Create Elysia app with enhanced logging
// Create limiters
const globalLimiter = createStandardLimiter(300, 500);
const strictLimiter = createStrictLimiter(60, 90); // use for heavy/AI routes

const app = new Elysia()
  // Add request logging middleware
  .onBeforeHandle(({ request, set }) => {
    const url = new URL(request.url);
    const method = request.method;
    const requestId = Math.random().toString(36).substring(2, 15);

    return startHttpTransaction(method, url.pathname, requestId, () => {
      const timer = createTimer();

      // Add request ID to headers for tracing
      set.headers = set.headers || {};
      set.headers['x-request-id'] = requestId;

      // Skip logging for health check endpoints to reduce noise
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

      // Store timer and request ID for response logging
      (request as RequestWithTracking)._timer = timer;
      (request as RequestWithTracking)._requestId = requestId;
    });
  })
  // Global rate limiting (lightweight)
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
  // Add response logging middleware
  .onAfterHandle(({ request, response, set }) => {
    const trackedRequest = request as RequestWithTracking;
    const timer = trackedRequest._timer;
    const requestId = trackedRequest._requestId;
    const duration = timer ? timer.end() : undefined;

    // Skip logging for health check endpoints to reduce noise
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
  // Add error handling middleware
  .onError(({ error, request, set }) => {
    const trackedRequest = request as RequestWithTracking;
    const requestId = trackedRequest._requestId;
    const timer = trackedRequest._timer;
    const duration = timer ? timer.end() : undefined;

    // Handle different error types
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const errorStack = error instanceof Error ? error.stack : undefined;

    // Capture error in Sentry
    captureException(error instanceof Error ? error : new Error(errorMessage), {
      requestId,
      method: request.method,
      url: request.url,
      duration: duration ? `${duration}ms` : undefined,
      userAgent: request.headers.get('user-agent'),
    });

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

    // Set appropriate status code
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
  // Add security headers middleware (after CORS to avoid conflicts)
  .onAfterHandle(({ set }) => {
    // Prevent MIME type sniffing
    set.headers = set.headers || {};
    set.headers['X-Content-Type-Options'] = 'nosniff';
    // Prevent clickjacking
    set.headers['X-Frame-Options'] = 'DENY';
    // Enable XSS protection
    set.headers['X-XSS-Protection'] = '1; mode=block';
    // Referrer policy
    set.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
    // Content Security Policy for API responses
    set.headers['Content-Security-Policy'] = "default-src 'none'";
    // HSTS - Force HTTPS for 1 year (only in production)
    if (process.env.NODE_ENV === 'production') {
      set.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains; preload';
    }
    // Note: Vary header is set by CORS middleware
  })
  .use(
    trpc(appRouter, {
      createContext,
      endpoint: '/trpc',
    })
  );

app
  // Health check endpoint (GET and HEAD)
  .get('/health', () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    };
  })
  .head('/health', ({ set }: { set: { status: number; headers: Record<string, string> } }) => {
    set.status = 200;
    set.headers['Content-Type'] = 'application/json';
    return;
  })
  // Database health check endpoint - returns database connection status
  .get('/health/db', async ({ set }: { set: { status: number } }) => {
    try {
      // Test database connection with a simple query
      const startTime = Date.now();
      await db.execute(sql`SELECT 1 as health_check`);
      const queryTime = Date.now() - startTime;

      const connectionStats = getConnectionStats();
      const activeConnections = await getActiveConnectionsCount();

      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: {
          connected: true,
          queryTime: `${queryTime}ms`,
          poolConfig: connectionStats,
          activeConnections,
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
  // WebSocket health check endpoint - returns WebSocket connection stats
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
  // WebSocket endpoint using Elysia's native WebSocket support
  .ws('/', {
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WebSocket types not well documented
    open: async (ws: any) => {
      const connectionId = Math.random().toString(36).substring(2, 15);
      const connectionLogger = wsLogger.child({ connectionId });

      // Require auth via query param token
      let authenticatedUserId: string | null = null;
      try {
        // In Elysia WebSocket, query params are in ws.data.query
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

      connectionLogger.info(
        {
          userId: authenticatedUserId,
        },
        '🔗 WebSocket client connected'
      );

      // Store connection metadata
      ws.data.connectionId = connectionId;
      ws.data.userId = authenticatedUserId;
      ws.data.connectedAt = Date.now();

      // Register with real-time updates service
      const realTimeUpdatesService = Container.get(RealTimeUpdatesService);
      realTimeUpdatesService.registerConnection({
        userId: authenticatedUserId,
        connectionId,
      });

      // Subscribe to user's topic for pub/sub
      ws.subscribe(`user:${authenticatedUserId}`);

      // Send connection confirmation
      ws.send(
        JSON.stringify({
          type: 'connected',
          connectionId,
          subscriptions: ['institution', 'account', 'holding', 'token'],
          timestamp: new Date().toISOString(),
        })
      );
    },
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WebSocket types not well documented
    message: (ws: any, message: any) => {
      // Forward message to realTimeUpdatesService for handling
      if (ws.data.connectionId) {
        const connectionLogger = wsLogger.child({
          connectionId: ws.data.connectionId,
        });
        connectionLogger.debug({ message }, '📨 WebSocket message received');

        // Handle subscription messages, pings, etc.
        const realTimeUpdatesService = Container.get(RealTimeUpdatesService);
        realTimeUpdatesService.handleMessage(ws.data.connectionId, message);
      }
    },
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WebSocket types not well documented
    close: (ws: any, code: any, reason: any) => {
      // Notify realTimeUpdatesService about disconnection
      if (ws.data?.connectionId) {
        const connectionLogger = wsLogger.child({
          connectionId: ws.data.connectionId,
        });
        connectionLogger.info(
          {
            code,
            reason,
          },
          '🔚 WebSocket client disconnected'
        );

        // Clean up connection tracking
        const realTimeUpdatesService = Container.get(RealTimeUpdatesService);
        realTimeUpdatesService.handleDisconnection(ws.data.connectionId);
      }
    },
  })
  // Stricter limiter for AI-related HTTP endpoints (if any are added later)
  .onBeforeHandle(({ request, set }) => {
    // Apply only to the tRPC endpoint with potential heavy procedures
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
      // ignore parsing issues, fail open to avoid blocking unrelated routes
    }
  });

wsLogger.info(
  {
    port: PORT,
    host: HOST,
  },
  '🔌 WebSocket endpoint configured (using Elysia native WebSocket)'
);

// Start HTTP server with enhanced logging
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

// Initialize real-time updates service with Elysia app
const realTimeUpdatesService = Container.get(RealTimeUpdatesService);
realTimeUpdatesService.setElysiaApp(app);
realTimeUpdatesService.initialize();

// Graceful shutdown with logging
const gracefulShutdown = async (signal: string) => {
  logger.info({ signal }, '🛑 Graceful shutdown initiated');

  logger.info({}, 'Flushing Sentry events...');
  await flush(2000);

  logger.info({}, 'Closing HTTP server...');
  server.stop();

  logger.info({}, 'Closing Sentry connection...');
  await close(2000);

  logger.info({}, '🏁 Graceful shutdown completed');
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', async (error) => {
  // Capture in Sentry before logging
  captureException(error, {
    type: 'uncaughtException',
    fatal: true,
  });

  logger.fatal(
    {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    },
    '💀 Uncaught Exception - shutting down'
  );

  // Give Sentry time to send the error
  await flush(2000);
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));

  // Capture in Sentry before logging
  captureException(error, {
    type: 'unhandledRejection',
    promise: promise.toString(),
    fatal: true,
  });

  logger.fatal(
    {
      reason,
      promise: promise.toString(),
    },
    '💀 Unhandled Promise Rejection - shutting down'
  );

  // Give Sentry time to send the error
  await flush(2000);
  process.exit(1);
});

export type { AppRouter } from './presentation/router';
