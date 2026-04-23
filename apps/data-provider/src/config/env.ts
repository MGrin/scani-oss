import { isProduction, requiredInProd } from '@scani/config';
import { z } from 'zod';

/**
 * data-provider env schema.
 *
 * This service owns every Scani-managed third-party API key and exposes them
 * over tRPC to backend/worker. Keys for provider families that have not yet
 * migrated are still optional so the service can boot during phase-by-phase
 * rollout; each phase tightens the requirement for the providers it moved.
 */
const envSchema = z
  .object({
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

    // ── Provider credentials. These move into data-provider across the
    // phased migration; each is still optional at the schema level so the
    // service boots with a partial key set during rollout. Router code for
    // an unmigrated provider will throw at call-time with a clear message.

    // Pricing (phase 1).
    COINGECKO_API_KEY: z.string().optional(),
    FINNHUB_API_KEY: z.string().optional(),
    // Google Sheets pricing provider (manual-asset prices). The provider
    // reads `process.env.GOOGLE_SERVICE_ACCOUNT_KEY` (a base64-encoded
    // JSON service-account key — see packages/pricing-providers/src/
    // providers/google-sheets.ts:727) and `GOOGLE_SHEETS_ID` directly.
    // Schema is the source of truth so the deploy job knows which
    // Fly secrets to stage. Both optional — provider returns empty if
    // either is missing.
    GOOGLE_SERVICE_ACCOUNT_KEY: z.string().optional(),
    GOOGLE_SHEETS_ID: z.string().optional(),

    // AI (phase 2).
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_VISION_MODEL: z.string().optional(),
    PERPLEXITY_API_KEY: z.string().optional(),
    DEEPSEEK_API_KEY: z.string().optional(),
    DEEPSEEK_VISION_MODEL: z.string().optional(),
    AI_DEFAULT_PROVIDER: z.string().optional(),

    // Public chains (phase 3).
    ETHERSCAN_API_KEY: z.string().optional(),
    HELIUS_API_KEY: z.string().optional(),

    // Email (phase 4).
    SMTP_URL: z.string().optional(),
    SMTP_FROM: z.string().optional(),
    FASTMAIL_API_TOKEN: z.string().optional(),

    // Object storage (phase 5).
    R2_ENDPOINT: z.string().url().optional(),
    R2_PUBLIC_ENDPOINT: z.string().url().optional(),
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().optional(),
  })
  // Silence unused-import warnings in dev: `requiredInProd` will be used
  // once per-phase tightening lands (phases 1-5 promote provider keys
  // from optional to prod-required inside this same schema).
  .transform((v) => {
    void requiredInProd;
    return v;
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
  if (cached.CLOUD_MANAGEMENT_ENABLED && !cached.FASTMAIL_API_TOKEN) {
    if (isProduction) {
      console.error(
        '❌ env: CLOUD_MANAGEMENT_ENABLED=true but FASTMAIL_API_TOKEN is not set. Cloud-frontend sign-in requires an email sender.'
      );
      process.exit(1);
    }
    console.warn(
      '⚠️  env: FASTMAIL_API_TOKEN unset — magic links / OTPs will be logged to stdout instead of sent. (dev-only bypass; production requires a token.)'
    );
  }
  return cached;
}
