import { cors } from '@elysiajs/cors';
import { trpc } from '@elysiajs/trpc';
import { Elysia } from 'elysia';
import { WebSocketServer } from 'ws';
import { supabase } from './lib/supabase';
import { createStandardLimiter, createStrictLimiter } from './middleware/rate-limit';
import { appRouter } from './router';
import { realTimeUpdatesService } from './services/real-time-updates';
import { createContext } from './trpc';
import { createTimer, logger, wsLogger } from './utils/logger';

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
    const timer = createTimer();
    const requestId = Math.random().toString(36).substring(2, 15);

    // Add request ID to headers for tracing
    set.headers = set.headers || {};
    set.headers['x-request-id'] = requestId;

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

    // Store timer and request ID for response logging
    (request as RequestWithTracking)._timer = timer;
    (request as RequestWithTracking)._requestId = requestId;
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
  )
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

// Create WebSocket server for real-time updates with enhanced logging
// Use noServer mode - we'll attach to HTTP server after it's created
const wss = new WebSocketServer({
  noServer: true, // Don't create a new HTTP server
  maxPayload: 256 * 1024, // 256KB
});

wsLogger.info(
  {
    port: PORT,
    host: HOST,
  },
  '🔌 WebSocket server initializing (will attach to HTTP server)'
);

// WebSocket connection handling with comprehensive logging
wss.on('connection', async (ws, req) => {
  const connectionId = Math.random().toString(36).substring(2, 15);
  const clientIP = req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];

  const connectionLogger = wsLogger.child({ connectionId });

  // Require auth via query param token (e.g., ws://host:port?token=JWT)
  let authenticatedUserId: string | null = null;
  try {
    const urlStr = req.url || '/';
    const url = new URL(urlStr, `ws://${HOST}:${PORT}`);
    const token = url.searchParams.get('token') || undefined;
    if (!token) {
      ws.close(4401, 'Unauthorized');
      return;
    }
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      ws.close(4401, 'Unauthorized');
      return;
    }
    authenticatedUserId = data.user.id;
  } catch {
    ws.close(1011, 'Auth failure');
    return;
  }

  connectionLogger.info(
    {
      clientIP,
      userAgent,
      url: req.url,
      userId: authenticatedUserId,
    },
    '🔗 WebSocket client connected'
  );
  // Heartbeat flags
  // Track connection liveness for heartbeat without weakening types
  (ws as unknown as { isAlive?: boolean }).isAlive = true;
  ws.on('pong', () => {
    (ws as unknown as { isAlive?: boolean }).isAlive = true;
  });

  ws.on('close', (code, reason) => {
    connectionLogger.info(
      {
        code,
        reason: reason.toString(),
      },
      '🔚 WebSocket client disconnected'
    );
  });

  ws.on('error', (error) => {
    connectionLogger.error(
      {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      },
      '⚠️ WebSocket connection error'
    );
  });

  realTimeUpdatesService.registerConnection(ws, {
    userId: authenticatedUserId,
    connectionId,
    request: req,
  });
});

wss.on('error', (error) => {
  wsLogger.error(
    {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    },
    '💥 WebSocket server error'
  );
});

// Heartbeat to terminate dead connections and enforce max connection age
const MAX_WS_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const heartbeat = setInterval(() => {
  wss.clients.forEach((client) => {
    const sock = client as unknown as {
      isAlive?: boolean;
      ping: () => void;
      terminate: () => void;
      _connectedAt?: number;
    };
    // Initialize connection time if not set
    if (!sock._connectedAt) {
      sock._connectedAt = Date.now();
    }
    if (sock.isAlive === false) {
      client.terminate();
      return;
    }
    // Enforce max age for token freshness (require reconnect)
    if (Date.now() - (sock._connectedAt || 0) > MAX_WS_AGE_MS) {
      client.terminate();
      return;
    }
    sock.isAlive = false;
    client.ping();
  });
}, 30000);

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

// Attach WebSocket upgrade handler to the HTTP server
// Get the underlying Node.js HTTP server from Elysia
const httpServer = (server as unknown as { server: import('http').Server }).server;
if (httpServer && typeof httpServer.on === 'function') {
  httpServer.on(
    'upgrade',
    (request: import('http').IncomingMessage, socket: import('stream').Duplex, head: Buffer) => {
      wsLogger.info(
        {
          url: request.url,
          origin: request.headers.origin,
        },
        '🔄 WebSocket upgrade request received'
      );

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  );

  wsLogger.info('✅ WebSocket upgrade handler attached to HTTP server');
} else {
  wsLogger.error('❌ Failed to attach WebSocket upgrade handler - no underlying HTTP server found');
}

// Graceful shutdown with logging
const gracefulShutdown = (signal: string) => {
  logger.info({ signal }, '🛑 Graceful shutdown initiated');

  logger.info('Closing HTTP server...');
  server.stop();

  logger.info('Closing WebSocket server...');
  wss.close(() => {
    logger.info('WebSocket server closed');
  });
  clearInterval(heartbeat);

  logger.info('🏁 Graceful shutdown completed');
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
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
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.fatal(
    {
      reason,
      promise: promise.toString(),
    },
    '💀 Unhandled Promise Rejection - shutting down'
  );
  process.exit(1);
});

export type { AppRouter } from './router';
