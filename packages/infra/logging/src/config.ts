import { getNodeEnv, isNodeEnvProduction } from '@scani/config';
import { z } from 'zod';

// Env shape owned by this package. Apps that depend on @scani/logging don't
// declare these in their own env.ts schemas — they just set the env vars and
// the logger self-validates at module load.
//
// `SERVICE_NAME` is set per-container so a shared log stream can distinguish
// api / worker / data-provider rows; `SERVICE_VERSION` is staged per-deploy
// from `${GITHUB_SHA}`.
const envSchema = z
  .object({
    LOG_LEVEL: z.string().optional(),
    LOG_PRETTY: z.string().optional(),
    LOG_TIMESTAMP: z.string().optional(),
    LOG_COLORIZE: z.string().optional(),
    LOG_SQL_QUERIES: z.string().optional(),
    LOG_REQUEST_BODIES: z.string().optional(),
    LOG_RESPONSE_BODIES: z.string().optional(),
    LOG_WEBSOCKET_MESSAGES: z.string().optional(),
    SERVICE_NAME: z.string().optional(),
    SERVICE_VERSION: z.string().optional(),
    HOSTNAME: z.string().optional(),
    LOG_ID_PEPPER: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (!isNodeEnvProduction()) return;
    // Hard-refuse body logging in production. The flags are debug knobs
    // that ship raw request/response payloads (including magic-link tokens,
    // OAuth callbacks, and credential imports) to the log aggregator with
    // no scrubbing. If an operator flips one in prod for "just a quick
    // look", every authenticated request in that window leaks.
    for (const flag of ['LOG_REQUEST_BODIES', 'LOG_RESPONSE_BODIES'] as const) {
      if (env[flag] === 'true') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [flag],
          message:
            'LOG_REQUEST_BODIES / LOG_RESPONSE_BODIES are debug-only flags and ' +
            'must not be enabled in production. Refusing to start.',
        });
      }
    }
    // Without a pepper, pseudonymizeId would forward raw tenant UUIDs to the
    // shared log aggregator. Fail boot rather than leak silently.
    if (!env.LOG_ID_PEPPER || env.LOG_ID_PEPPER.length < 16) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOG_ID_PEPPER'],
        message:
          'LOG_ID_PEPPER is required in production and must be at least 16 chars. ' +
          'Generate with `openssl rand -hex 32` and set it as an environment ' +
          'variable on every backend service (api, worker, data-provider).',
      });
    }
  });

export interface LoggingConfig {
  level: string;
  pretty: boolean;
  timestamp: boolean;
  colorize: boolean;
  logSqlQueries: boolean;
  logRequestBodies: boolean;
  logResponseBodies: boolean;
  logWebSocketMessages: boolean;
  serviceName: string;
  serviceVersion: string;
  hostname: string;
  logIdPepper: string | undefined;
}

let cached: LoggingConfig | null = null;

export function loadLoggingConfig(env: NodeJS.ProcessEnv = process.env): LoggingConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`@scani/logging env misconfigured:\n${issues}`);
  }
  const raw = parsed.data;
  const isProductionEnv = isNodeEnvProduction();
  // `isDevelopment` is not the complement of `isProductionEnv` — `NODE_ENV=test`
  // (Bun's default) makes both false.
  const isDevelopment = getNodeEnv() === 'development' || !getNodeEnv();
  cached = {
    level: (raw.LOG_LEVEL || (isDevelopment ? 'debug' : 'info')).toLowerCase(),
    pretty: isProductionEnv ? false : raw.LOG_PRETTY === 'true' || isDevelopment,
    timestamp: raw.LOG_TIMESTAMP !== 'false',
    colorize: isProductionEnv ? false : raw.LOG_COLORIZE !== 'false' && isDevelopment,
    logSqlQueries: raw.LOG_SQL_QUERIES === 'true',
    logRequestBodies: !isProductionEnv && raw.LOG_REQUEST_BODIES === 'true',
    logResponseBodies: !isProductionEnv && raw.LOG_RESPONSE_BODIES === 'true',
    logWebSocketMessages: raw.LOG_WEBSOCKET_MESSAGES !== 'false',
    serviceName: raw.SERVICE_NAME || 'scani',
    serviceVersion: raw.SERVICE_VERSION || 'unknown',
    hostname: raw.HOSTNAME || 'localhost',
    logIdPepper: raw.LOG_ID_PEPPER,
  };
  return cached;
}

export function resetLoggingConfig(): void {
  cached = null;
}
