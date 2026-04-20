import pino from 'pino';

/**
 * Custom logger types for better developer experience.
 *
 * Pino supports two calling patterns:
 * 1. logger.info('Simple message') - for basic logging
 * 2. logger.info({ key: 'value' }, 'Message with context') - for structured logging
 *
 * Our custom formatter handles both patterns automatically.
 */
export type LogContext = object;

/**
 * Logger interface that supports both simple and structured logging.
 *
 * @example
 * // Simple logging
 * logger.info('User logged in');
 *
 * @example
 * // Structured logging with context
 * logger.info({ userId: '123', email: 'user@example.com' }, 'User logged in');
 */
export interface CustomLogger extends pino.Logger {
  trace(message: string): void;
  trace(obj: LogContext, message: string): void;

  debug(message: string): void;
  debug(obj: LogContext, message: string): void;

  info(message: string): void;
  info(obj: LogContext, message: string): void;

  warn(message: string): void;
  warn(obj: LogContext, message: string): void;

  error(message: string): void;
  error(obj: LogContext, message: string): void;

  fatal(message: string): void;
  fatal(obj: LogContext, message: string): void;
}

// Determine environment mode
const isProduction = process.env.NODE_ENV === 'production';
const isDevelopment = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;

// Configuration from environment variables
export const logConfig = {
  level: (process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info')).toLowerCase(),
  pretty: isProduction ? false : process.env.LOG_PRETTY === 'true' || isDevelopment,
  timestamp: process.env.LOG_TIMESTAMP !== 'false',
  colorize: isProduction ? false : process.env.LOG_COLORIZE !== 'false' && isDevelopment,
  logSqlQueries: process.env.LOG_SQL_QUERIES === 'true',
  logRequestBodies: process.env.LOG_REQUEST_BODIES === 'true',
  logResponseBodies: process.env.LOG_RESPONSE_BODIES === 'true',
  logWebSocketMessages: process.env.LOG_WEBSOCKET_MESSAGES !== 'false',
};

/**
 * Redact sensitive query parameters from URLs before logging.
 * Prevents JWT tokens, API keys, etc. from appearing in log output.
 */
const SENSITIVE_PARAMS = new Set([
  'token',
  'api_key',
  'apikey',
  'key',
  'secret',
  'password',
  'authorization',
]);

export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const param of SENSITIVE_PARAMS) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, '[REDACTED]');
        changed = true;
      }
    }
    return changed ? parsed.toString() : url;
  } catch {
    return url.replace(
      /([?&])(token|api_key|apikey|key|secret|password|authorization)=[^&]*/gi,
      '$1$2=[REDACTED]'
    );
  }
}

// Custom human-readable console writer for development
const createHumanReadableLogger = () => {
  // Color codes
  const colors = {
    trace: '\x1b[90m', // gray
    debug: '\x1b[36m', // cyan
    info: '\x1b[32m', // green
    warn: '\x1b[33m', // yellow
    error: '\x1b[31m', // red
    fatal: '\x1b[35m', // magenta
    reset: '\x1b[0m', // reset
  };

  const levelNames: Record<number, keyof typeof colors> = {
    10: 'trace',
    20: 'debug',
    30: 'info',
    40: 'warn',
    50: 'error',
    60: 'fatal',
  };

  const levelEmojis: Record<string, string> = {
    trace: '🔍',
    debug: '🐛',
    info: '📝',
    warn: '⚠️',
    error: '❌',
    fatal: '💀',
  };

  return pino({
    level: logConfig.level,
    base: {
      pid: process.pid,
      hostname: process.env.HOSTNAME || 'localhost',
      service: 'scani-backend',
      version: process.env.npm_package_version || '1.0.0',
    },
    timestamp: logConfig.timestamp ? () => `,"timestamp":"${new Date().toISOString()}"` : false,
    formatters: {
      log: (object: Record<string, unknown>) => ({
        ...object,
        environment: process.env.NODE_ENV || 'development',
      }),
    },
    hooks: {
      logMethod: (inputArgs, method, level) => {
        if (logConfig.pretty) {
          // Handle both patterns:
          // 1. logger.info('message') - single string parameter
          // 2. logger.info({ data }, 'message') - object + string parameters
          let logObj: Record<string, unknown>;
          let message: string;

          if (typeof inputArgs[0] === 'string') {
            // Pattern 1: Single string parameter
            message = inputArgs[0];
            logObj = {};
          } else {
            // Pattern 2: Object + string parameters
            logObj = (inputArgs[0] as Record<string, unknown>) || {};
            message = (inputArgs[1] as string) || '';
          }

          // Format timestamp
          const timestamp = new Date().toLocaleTimeString('en-US', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          } as Intl.DateTimeFormatOptions);

          const levelName = levelNames[level] || 'info';
          const emoji = levelEmojis[levelName] || '📝';
          const color = logConfig.colorize ? colors[levelName] : '';
          const reset = logConfig.colorize ? colors.reset : '';

          // Component and request tracking
          const component = logObj.component
            ? `[${(logObj.component as string).toUpperCase()}]`
            : '';
          const requestId = logObj.requestId
            ? `{${(logObj.requestId as string).substring(0, 8)}}`
            : '';

          // Context information
          const context: string[] = [];

          if (logObj.method && logObj.url) {
            context.push(`${logObj.method} ${logObj.url}`);
          }

          if (logObj.procedure) {
            context.push(`${logObj.procedure}`);
          }

          if (logObj.duration) {
            context.push(`⏱️ ${logObj.duration}`);
          }

          if (logObj.statusCode) {
            const emoji = (logObj.statusCode as number) >= 400 ? '🔴' : '🟢';
            context.push(`${emoji}${logObj.statusCode}`);
          }

          if (logObj.connectionId) {
            context.push(`conn:${(logObj.connectionId as string).substring(0, 8)}`);
          }

          if (logObj.query) {
            const queryStr = logObj.query as string;
            const queryPreview = queryStr.substring(0, 40) + (queryStr.length > 40 ? '...' : '');
            context.push(`SQL:${queryPreview}`);
          }

          if (logObj.error) {
            const error = logObj.error as { name: string; message: string };
            context.push(`❌${error.name}:${error.message}`);
          }

          if (logObj.messageType) {
            context.push(`WS:${logObj.messageType}`);
          }

          // Catch-all: anything structured the caller passed that we didn't
          // explicitly render above still gets shown. Previously the hook
          // silently dropped `jobId`, `name`, `durationMs`, etc. — which is
          // why worker logs read "▶️ Processing job" with no clue which
          // job was running. Excludes pino internals and already-rendered
          // keys. Keep values short so lines stay scannable.
          const reservedKeys = new Set([
            'component',
            'requestId',
            'method',
            'url',
            'procedure',
            'duration',
            'statusCode',
            'connectionId',
            'query',
            'error',
            'messageType',
            // pino / base
            'level',
            'time',
            'timestamp',
            'pid',
            'hostname',
            'service',
            'version',
            'environment',
            'msg',
            'v',
          ]);
          for (const [key, value] of Object.entries(logObj)) {
            if (reservedKeys.has(key)) continue;
            if (value === undefined || value === null || value === '') continue;
            const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
            const short = rendered.length > 100 ? `${rendered.slice(0, 97)}...` : rendered;
            context.push(`${key}=${short}`);
          }

          const contextStr = context.length > 0 ? ` | ${context.join(' | ')}` : '';
          const humanReadable = `${color}🕒 ${timestamp} ${emoji} ${levelName
            .toUpperCase()
            .padEnd(5)} ${component} ${requestId} ${message}${contextStr}${reset}`;

          console.log(humanReadable);
        } else {
          return method.apply(this, inputArgs);
        }
      },
    },
  });
};

// Create the logger
export const logger = (
  logConfig.pretty
    ? createHumanReadableLogger()
    : pino({
        level: logConfig.level,
        base: {
          pid: process.pid,
          hostname: process.env.HOSTNAME || 'localhost',
          service: 'scani-backend',
          version: process.env.npm_package_version || '1.0.0',
        },
        timestamp: logConfig.timestamp ? () => `,"timestamp":"${new Date().toISOString()}"` : false,
        formatters: {
          log: (object: Record<string, unknown>) => ({
            ...object,
            environment: process.env.NODE_ENV || 'development',
          }),
        },
      })
) as CustomLogger;

// Create child loggers for different components
export const createComponentLogger = (component: string): CustomLogger => {
  return logger.child({ component }) as CustomLogger;
};

// tRPC specific logger
export const trpcLogger = createComponentLogger('trpc');

// Database logger
export const dbLogger = createComponentLogger('database');

// WebSocket logger
export const wsLogger = createComponentLogger('websocket');

// Auth logger (for future use)
export const authLogger = createComponentLogger('auth');

// Utility function to log request/response cycles
export const logRequestResponse = (
  logger: CustomLogger,
  req: {
    method?: string;
    url?: string;
    headers?: Record<string, string | string[]>;
    body?: unknown;
  },
  res: {
    statusCode?: number;
    headers?: Record<string, string | string[]>;
    body?: unknown;
  },
  duration?: number,
  error?: Error
) => {
  const logData = {
    req: {
      method: req.method,
      url: req.url,
      userAgent: req.headers?.['user-agent'],
      contentType: req.headers?.['content-type'],
      bodySize:
        logConfig.logRequestBodies && req.body ? JSON.stringify(req.body).length : undefined,
    },
    res: {
      statusCode: res.statusCode,
      contentType: res.headers?.['content-type'],
      bodySize:
        logConfig.logResponseBodies && res.body ? JSON.stringify(res.body).length : undefined,
    },
    duration: duration ? `${duration}ms` : undefined,
    error: error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
      : undefined,
  };

  if (error) {
    logger.error(logData, `Request failed: ${error.message}`);
  } else if (res.statusCode && res.statusCode >= 400) {
    logger.warn(logData, `Request completed with error status: ${res.statusCode}`);
  } else {
    logger.info(logData, `Request completed successfully`);
  }
};

// Utility function to create a request ID for tracing
export const generateRequestId = (): string => {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

// Performance timing utility
export const createTimer = () => {
  const start = process.hrtime.bigint();
  return {
    end: () => {
      const end = process.hrtime.bigint();
      return Number(end - start) / 1_000_000; // Convert to milliseconds
    },
  };
};
