import { isProduction } from '@scani/config';
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

  // Feature flag: when true (and DATABASE_URL is set) the data-provider
  // runs in Tier 2/3 mode — DB-backed api keys, Better-Auth cookie
  // sessions for cloud-frontend, and per-request usage logging.
  CLOUD_MANAGEMENT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  // Better-Auth config (only consumed when CLOUD_MANAGEMENT_ENABLED).
  // Secret signs session tokens; trusted origins scope CORS+cookies.
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().url().optional(),
  CLOUD_FRONTEND_ORIGIN: z.string().url().optional(),

  // Sentry (optional; init gates on DSN presence).
  SENTRY_DSN: z.string().url().optional(),
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

  if (isProduction && !cached.SENTRY_DSN) {
    console.warn('⚠️  env: SENTRY_DSN unset — errors will not be reported to Sentry.');
  }
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
  return cached;
}
