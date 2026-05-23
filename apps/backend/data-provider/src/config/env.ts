import { checkEnvIsolatedUrl, isProduction, requiredInProd } from '@scani/config';
import { z } from 'zod';

/**
 * data-provider env schema.
 *
 * This service owns every Scani-managed third-party API key and exposes them
 * over tRPC to backend/worker. Keys for provider families that have not yet
 * migrated are still optional so the service can boot during phase-by-phase
 * rollout; each phase tightens the requirement for the providers it moved.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : 8082))
    .refine((n) => Number.isFinite(n) && n > 0 && n < 65536, {
      message: 'PORT must be a valid port number',
    }),
  HOST: z.string().default('localhost'),

  // Public origin this service is reachable on. Used by the OpenAPI
  // doc's `servers[]` so generated docs/SDKs hit the right URL. Falls
  // back to a localhost URL constructed from HOST + PORT when unset
  // (fine for OSS / dev). Production should set this explicitly to the
  // service's public HTTPS URL.
  PUBLIC_BASE_URL: z.string().url().optional(),

  // Redis backs the per-provider rate-limiter buckets. Single-tenant in
  // OSS; colocated with backend Redis in managed deployments (different
  // key prefix).
  REDIS_URL: z.string().url(),

  // Postgres is optional for Tier 1 OSS (env-based bearer key + no usage
  // log). Required for Tier 2/3 managed, where it backs `cloud_api_keys`,
  // `cloud_users`, and Better-Auth session tables.
  DATABASE_URL: z.string().optional(),

  // OSS / Tier-1 auth: a single shared bearer token. Managed tier swaps
  // this for a DB lookup against `cloud_api_keys` (enabled by
  // `CLOUD_MANAGEMENT_ENABLED=true` + `DATABASE_URL`). The env token
  // remains valid as a superuser fallback in both modes.
  DATA_PROVIDER_API_KEY: isProduction
    ? z.string().min(16, { message: 'DATA_PROVIDER_API_KEY must be >=16 chars in production' })
    : z.string().optional(),

  // Optional ISO-8601 timestamp gating the superuser bearer above. When
  // set, requests after the window are rejected with 401 even if the
  // token still matches. Lets ops rotate without a deploy: set the new
  // key + an expiry on the old, peel the old after the window passes.
  DATA_PROVIDER_API_KEY_EXPIRES_AT: z
    .string()
    .datetime({ message: 'DATA_PROVIDER_API_KEY_EXPIRES_AT must be an ISO-8601 timestamp' })
    .optional(),

  // Feature flag: when true (and DATABASE_URL is set) the data-provider
  // runs in Tier 2/3 mode — DB-backed api keys, Better-Auth cookie
  // sessions for cloud-frontend, and per-request usage logging.
  CLOUD_MANAGEMENT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  // Default per-API-key request budget over a 1-hour rolling window.
  // 0 (or unset) = quota disabled — OSS / dev boots unmetered. The
  // bearer middleware reads the running counter from Redis and rejects
  // with `FORBIDDEN { code: 'quota_exceeded' }` when the budget is gone.
  // Per-tier / per-key overrides are a future improvement; this is the
  // single global ceiling so a runaway tenant can't burn unbounded
  // upstream cost.
  CLOUD_QUOTA_HOURLY_DEFAULT: z
    .string()
    .optional()
    .default('0')
    .transform((v) => Number.parseInt(v, 10))
    .refine((n) => Number.isFinite(n) && n >= 0, {
      message: 'CLOUD_QUOTA_HOURLY_DEFAULT must be a non-negative integer',
    }),

  // Org-wide hourly cap on cumulative `upstreamCostUsd` across all
  // tenants. Trips the GlobalCostBreaker when exceeded; subsequent
  // requests get 503 until the next hour-bucket. Decimal supported
  // for cents-level granularity. 0 / unset disables the breaker.
  GLOBAL_HOURLY_USD_CAP: z
    .string()
    .optional()
    .default('0')
    .transform((v) => Number.parseFloat(v))
    .refine((n) => Number.isFinite(n) && n >= 0, {
      message: 'GLOBAL_HOURLY_USD_CAP must be a non-negative number',
    }),

  // Better-Auth config (only consumed when CLOUD_MANAGEMENT_ENABLED).
  // Secret signs session tokens; trusted origins scope CORS+cookies.
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().url().optional(),
  CLOUD_FRONTEND_ORIGIN: z.string().url().optional(),

  // Sentry — hard-required in prod; optional in dev. SDK init gates
  // on DSN presence regardless.
  SENTRY_DSN: requiredInProd(z.string().url(), 'SENTRY_DSN'),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),

  // Per-provider keys (CoinGecko, Finnhub, Google Sheets, OpenAI,
  // Perplexity, DeepSeek, Etherscan, Helius, AI_DEFAULT_PROVIDER) are
  // owned by @scani/providers' env schema (loadProvidersConfig). The
  // data-provider always boots in `direct` mode, so all keys for the
  // providers it actually registers must be set here at deploy time.
  // Email config (FASTMAIL_API_TOKEN, SMTP_URL, SMTP_FROM) is owned by
  // @scani/email's own env schema. Object storage (S3_*) is owned by
  // @scani/storage's own env schema.
});

export type DataProviderEnv = z.infer<typeof envSchema>;

let cached: DataProviderEnv | undefined;

export function loadEnv(): DataProviderEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    console.error(`\n❌ Invalid data-provider environment:\n${issues}\n`);
    process.exit(1);
  }
  cached = parsed.data;
  if (cached.CLOUD_MANAGEMENT_ENABLED && !cached.DATABASE_URL) {
    console.error(
      '❌ env: CLOUD_MANAGEMENT_ENABLED=true but DATABASE_URL is not set. Tier 2/3 management requires a Postgres DB.'
    );
    process.exit(1);
  }
  if (cached.CLOUD_MANAGEMENT_ENABLED && !cached.BETTER_AUTH_SECRET) {
    console.error(
      '❌ env: CLOUD_MANAGEMENT_ENABLED=true but BETTER_AUTH_SECRET is not set. Cookie sessions require a signing secret.'
    );
    process.exit(1);
  }
  if (cached.CLOUD_MANAGEMENT_ENABLED && isProduction && !process.env.FASTMAIL_API_TOKEN) {
    console.error(
      '❌ env: CLOUD_MANAGEMENT_ENABLED=true but FASTMAIL_API_TOKEN is not set. Cloud-frontend sign-in requires an email sender.'
    );
    process.exit(1);
  }
  // Env-isolation check: warn-only, never exit. The previous version
  // called `assertEnvIsolatedUrl` which threw + process.exit(1) at
  // boot, and a stale NODE_ENV during the 2026-05-09 outage made
  // every machine crash-loop. The check is still useful to surface
  // a real env-misconfig (dev URL leaking into prod), but it must
  // not be load-bearing for boot.
  const redisCheck = checkEnvIsolatedUrl({ url: cached.REDIS_URL, varName: 'REDIS_URL' });
  if (!redisCheck.ok) {
    console.warn(`⚠️  env-isolation: ${redisCheck.reason}`);
  }
  if (cached.DATABASE_URL) {
    const dbCheck = checkEnvIsolatedUrl({ url: cached.DATABASE_URL, varName: 'DATABASE_URL' });
    if (!dbCheck.ok) {
      console.warn(`⚠️  env-isolation: ${dbCheck.reason}`);
    }
  }
  return cached;
}
