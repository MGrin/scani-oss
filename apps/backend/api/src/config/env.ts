import { httpsUrlInProduction, isProduction, requiredInProd, urlSchema } from '@scani/config';
import { z } from 'zod';

/**
 * Startup environment validation for the backend service.
 *
 * This schema is parsed once at boot. Missing or malformed environment
 * variables cause the process to exit with a clear error listing every
 * failing variable, instead of producing obscure runtime errors later.
 *
 * Shared helpers (`isProduction`, `urlSchema`, `httpsUrlInProduction`,
 * `requiredInProd`) live in `@scani/config` so the worker's schema can
 * reuse them without duplication.
 */

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : 3001))
    .refine((n) => Number.isFinite(n) && n > 0 && n < 65536, {
      message: 'PORT must be a valid port number',
    }),
  HOST: z.string().default('localhost'),

  // Postgres. Direct connection string (no PgBouncer needed — Neon / Fly
  // both provide direct connections).
  DATABASE_URL: urlSchema,

  // Redis. Required — powers BullMQ enqueue, WS pub/sub fan-out across
  // backend instances, and the rate limiter's shared bucket state.
  REDIS_URL: urlSchema,

  // Frontend origin for CORS. Required in production, must be https://.
  FRONTEND_URL: isProduction ? httpsUrlInProduction : urlSchema.default('http://localhost:5173'),

  // This backend's own public URL — Better-Auth needs it to generate
  // magic-link callback URLs that resolve to /api/auth/magic-link/verify.
  BACKEND_URL: isProduction ? httpsUrlInProduction : urlSchema.default('http://localhost:3001'),

  // Cookie domain shared by app.<domain> and api.<domain> so the session
  // cookie reaches both hosts (e.g. `.scani.xyz`). Leave unset in dev
  // where same-port cookies just work.
  COOKIE_DOMAIN: z.string().optional(),

  // ENCRYPTION_KEY is owned by @scani/security's own env schema. The api
  // and worker both depend on @scani/security, which validates the key on
  // first encrypt/decrypt call. Both sides MUST share the same key — else
  // the worker cannot decrypt what the api wrote and every exchange-import
  // silently fails.

  // Better-Auth session signing secret. Required in production.
  BETTER_AUTH_SECRET: isProduction
    ? z.string().min(32, { message: 'BETTER_AUTH_SECRET must be at least 32 chars in production' })
    : z.string().optional(),

  // Email config (FASTMAIL_API_TOKEN, SMTP_URL, SMTP_FROM) is owned by
  // @scani/email's own env schema; the api only sees it indirectly via
  // EmailFacade in @scani/cloud-client (which falls through to a
  // LocalEmailService when SCANI_CLOUD_URL is unset).

  // Per-provider keys (OPENAI_API_KEY,
  // OPENAI_VISION_MODEL,
  // COINGECKO_API_KEY, FINNHUB_API_KEY, ETHERSCAN_API_KEY, HELIUS_API_KEY,
  // GOOGLE_SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_KEY) are owned by
  // @scani/providers' env schema. They're only required on the host that
  // actually boots in `direct` mode — typically the data-provider in
  // production, or the api itself in OSS dev when SCANI_CLOUD_URL is unset.

  // Object storage (S3_*) is owned by @scani/storage's own env schema; the
  // api only sees it when SCANI_CLOUD_URL is unset and the storage-facade
  // in @scani/cloud-client falls through to the local StorageService.

  // Sentry — required in prod once the Terraform provision lands. Left
  // optional at the schema level so dev boots without it; the SDK init
  // checks for DSN presence before enabling.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),

  // HMAC shared secret for admin → backend actions (BullMQ retry/remove,
  // DLQ replay). Required in prod.
  ADMIN_JOBS_HMAC_SECRET: requiredInProd(z.string().min(32), 'ADMIN_JOBS_HMAC_SECRET'),

  // SCANI_CLOUD_URL + SCANI_CLOUD_API_KEY are owned by @scani/cloud-client's
  // own env schema. Required in prod; optional in dev (local fallback).
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    // Intentionally use console.error; logger may not be wired yet at boot.
    console.error(
      `\n❌ Invalid environment configuration:\n${issues}\n\n` +
        `Fix the above variables in your environment or .env file and restart.`
    );
    process.exit(1);
  }

  cached = parsed.data;

  if (isProduction && !cached.SENTRY_DSN) {
    console.warn('⚠️  env: SENTRY_DSN unset — errors will not be reported to Sentry.');
  }

  return cached;
}
