import { cors } from '@elysiajs/cors';
import { trpc } from '@elysiajs/trpc';
import { Elysia } from 'elysia';
import { WebSocketServer } from 'ws';
import { appRouter } from './router';
import { createContext } from './trpc';
import { createTimer, logConfig, logger, wsLogger } from './utils/logger';

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
    })
  )
  .use(
    trpc(appRouter, {
      createContext,
      endpoint: '/trpc',
    })
  );

// Create WebSocket server for real-time updates with enhanced logging
const wss = new WebSocketServer({
  port: PORT + 1,
  host: HOST,
});

wsLogger.info(
  {
    port: PORT + 1,
    host: HOST,
  },
  '🔌 WebSocket server initializing'
);

// WebSocket connection handling with comprehensive logging
wss.on('connection', (ws, req) => {
  const connectionId = Math.random().toString(36).substring(2, 15);
  const clientIP = req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];

  const connectionLogger = wsLogger.child({ connectionId });

  connectionLogger.info(
    {
      clientIP,
      userAgent,
      url: req.url,
    },
    '🔗 WebSocket client connected'
  );

  ws.on('message', (data) => {
    const messageTimer = createTimer();

    try {
      const message = JSON.parse(data.toString());
      const messageSize = data.toString().length;

      // Only log WebSocket messages if configured to do so
      if (logConfig.logWebSocketMessages) {
        connectionLogger.debug(
          {
            messageType: message.type,
            messageSize,
            timestamp: message.timestamp,
          },
          '📨 WebSocket message received'
        );
      }

      // Echo back for now - will be enhanced with real-time data updates
      const response = {
        type: 'echo',
        data: message,
        timestamp: new Date().toISOString(),
        connectionId,
      };

      ws.send(JSON.stringify(response));

      const duration = messageTimer.end();

      if (logConfig.logWebSocketMessages) {
        connectionLogger.debug(
          {
            responseSize: JSON.stringify(response).length,
            duration: `${duration}ms`,
          },
          '📤 WebSocket response sent'
        );
      }
    } catch (error) {
      const duration = messageTimer.end();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      connectionLogger.error(
        {
          error: {
            name: error instanceof Error ? error.name : 'ParseError',
            message: errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
          },
          rawData: data.toString().substring(0, 500), // Limit log size
          duration: `${duration}ms`,
        },
        '💥 WebSocket message parsing failed'
      );

      // Send error response
      ws.send(
        JSON.stringify({
          type: 'error',
          error: 'Invalid message format',
          timestamp: new Date().toISOString(),
          connectionId,
        })
      );
    }
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

  // Send welcome message
  const welcomeMessage = {
    type: 'welcome',
    message: 'Connected to Scani WebSocket server',
    timestamp: new Date().toISOString(),
    connectionId,
  };

  ws.send(JSON.stringify(welcomeMessage));

  if (logConfig.logWebSocketMessages) {
    connectionLogger.debug(
      {
        messageSize: JSON.stringify(welcomeMessage).length,
      },
      '👋 Welcome message sent'
    );
  }
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

// Start HTTP server with enhanced logging
const server = app.listen(PORT, () => {
  logger.info(
    {
      httpUrl: `http://${HOST}:${PORT}`,
      wsUrl: `ws://${HOST}:${PORT + 1}`,
      environment: process.env.NODE_ENV || 'development',
    },
    '🎉 Scani Backend Server started successfully'
  );
});

// Graceful shutdown with logging
const gracefulShutdown = (signal: string) => {
  logger.info({ signal }, '🛑 Graceful shutdown initiated');

  logger.info('Closing HTTP server...');
  server.stop();

  logger.info('Closing WebSocket server...');
  wss.close(() => {
    logger.info('WebSocket server closed');
  });

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
