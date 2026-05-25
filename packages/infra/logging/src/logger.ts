import { getNodeEnv, isNodeEnvProduction } from '@scani/config';
import pino from 'pino';

const isProductionEnv = isNodeEnvProduction();

export type LogContext = object;

// Pino accepts both `logger.info('msg')` and `logger.info({ ctx }, 'msg')`.
// The base type doesn't enforce that the second form passes a string second
// arg, so this overload set tightens it.
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

// `isDevelopment` is not the complement of `isProductionEnv` — `NODE_ENV=test`
// (Bun's default) makes both false. Keeping it local since `@scani/config`
// only exports the production gate.
const isDevelopment = getNodeEnv() === 'development' || !getNodeEnv();

// Each app sets `SERVICE_NAME` in its fly.toml / docker-compose env so a
// shared log stream can distinguish api / worker / data-provider rows.
// `SERVICE_VERSION` is staged per-deploy from `${GITHUB_SHA}`.
const serviceName = process.env.SERVICE_NAME || 'scani';
const serviceVersion = process.env.SERVICE_VERSION || 'unknown';

// Hard-refuse body logging in production. The flags are debug knobs
// that ship raw request/response payloads (including magic-link tokens,
// OAuth callbacks, and credential imports) to the log aggregator with
// no scrubbing. If an operator flips one in prod for "just a quick
// look", every authenticated request in that window leaks. The
// schema-level requiredInProd helper isn't available here (logging
// can't depend on @scani/config's env loader without a cycle), so
// guard at module load.
const requestBodyLogRequested = process.env.LOG_REQUEST_BODIES === 'true';
const responseBodyLogRequested = process.env.LOG_RESPONSE_BODIES === 'true';
if (isProductionEnv && (requestBodyLogRequested || responseBodyLogRequested)) {
  throw new Error(
    'LOG_REQUEST_BODIES / LOG_RESPONSE_BODIES are debug-only flags and ' +
      'must not be enabled in production. Refusing to start.'
  );
}

export const logConfig = {
  level: (process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info')).toLowerCase(),
  pretty: isProductionEnv ? false : process.env.LOG_PRETTY === 'true' || isDevelopment,
  timestamp: process.env.LOG_TIMESTAMP !== 'false',
  colorize: isProductionEnv ? false : process.env.LOG_COLORIZE !== 'false' && isDevelopment,
  logSqlQueries: process.env.LOG_SQL_QUERIES === 'true',
  logRequestBodies: !isProductionEnv && requestBodyLogRequested,
  logResponseBodies: !isProductionEnv && responseBodyLogRequested,
  logWebSocketMessages: process.env.LOG_WEBSOCKET_MESSAGES !== 'false',
};

const SENSITIVE_PARAMS = new Set([
  'token',
  'api_key',
  'apikey',
  'key',
  'secret',
  'password',
  'authorization',
]);

// Strips known auth-bearing query params before logging — JWTs, API keys
// etc. otherwise end up in log aggregators in plain text.
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
    // Fallback for inputs that aren't full URLs (relative paths,
    // partials emitted by middleware before the host is known).
    return url.replace(
      /([?&])(token|api_key|apikey|key|secret|password|authorization)=[^&]*/gi,
      '$1$2=[REDACTED]'
    );
  }
}

const createHumanReadableLogger = () => {
  const colors = {
    trace: '\x1b[90m',
    debug: '\x1b[36m',
    info: '\x1b[32m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
    fatal: '\x1b[35m',
    reset: '\x1b[0m',
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
      service: serviceName,
      version: serviceVersion,
    },
    timestamp: logConfig.timestamp ? () => `,"timestamp":"${new Date().toISOString()}"` : false,
    formatters: {
      log: (object: Record<string, unknown>) => ({
        ...object,
        environment: getNodeEnv() || 'development',
      }),
    },
    hooks: {
      logMethod: (inputArgs, method, level) => {
        if (logConfig.pretty) {
          let logObj: Record<string, unknown>;
          let message: string;

          if (typeof inputArgs[0] === 'string') {
            message = inputArgs[0];
            logObj = {};
          } else {
            logObj = (inputArgs[0] as Record<string, unknown>) || {};
            message = (inputArgs[1] as string) || '';
          }

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

          const component = logObj.component
            ? `[${(logObj.component as string).toUpperCase()}]`
            : '';
          const requestId = logObj.requestId
            ? `{${(logObj.requestId as string).substring(0, 8)}}`
            : '';

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

          // Catch-all for any structured field the caller passed that
          // isn't explicitly rendered above. Without this the hook
          // silently dropped jobId / name / durationMs etc., so worker
          // logs read "▶️ Processing job" with no clue which one.
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
            environment: getNodeEnv() || 'development',
          }),
        },
      })
) as CustomLogger;

export const createComponentLogger = (component: string): CustomLogger => {
  return logger.child({ component }) as CustomLogger;
};

export const generateRequestId = (): string => {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

export const createTimer = () => {
  const start = process.hrtime.bigint();
  return {
    end: () => {
      const end = process.hrtime.bigint();
      // hrtime returns nanoseconds; divide by 1e6 to get milliseconds.
      return Number(end - start) / 1_000_000;
    },
  };
};
