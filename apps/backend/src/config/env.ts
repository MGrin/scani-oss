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

  // Credential encryption key for integration credentials at rest.
  // Required in production; optional in dev so tests can skip it.
  // MUST match the worker's ENCRYPTION_KEY exactly — else the worker cannot
  // decrypt what the backend wrote, and every exchange-import silently fails.
  ENCRYPTION_KEY: isProduction
    ? z.string().min(32, { message: 'ENCRYPTION_KEY must be at least 32 chars in production' })
    : z.string().optional(),

  // Better-Auth session signing secret. Required in production.
  BETTER_AUTH_SECRET: isProduction
    ? z.string().min(32, { message: 'BETTER_AUTH_SECRET must be at least 32 chars in production' })
    : z.string().optional(),

  // Email delivery: either SMTP (OSS self-hosters) or Fastmail's JMAP API
  // (managed deployment — avoids needing a separate app-specific password
  // when a Fastmail API token with mail/send scope is available).
  SMTP_URL: z.string().optional(),
  // Accepts a bare `local@domain` or a display-name wrapper
  // `"Name" <local@domain>`. The Fastmail JMAP sender (in apps/backend/src/
  // auth/fastmail-jmap.ts on the auth-emails branch) parses the wrapper and
  // picks the matching account identity, so both shapes need to validate.
  SMTP_FROM: z
    .string()
    .refine((v) => /^(?:"[^"]*"\s*<[^>]+@[^>]+>|\S+@\S+)$/.test(v), {
      message: 'SMTP_FROM must be "Name" <email> or a bare email',
    })
    .optional(),
  FASTMAIL_API_TOKEN: z.string().optional(),

  // AI providers for screenshot parsing. Optional everywhere starting with
  // the data-provider split: when SCANI_CLOUD_URL is set (the expected prod
  // shape), every AI call goes through the data-provider, which carries the
  // real keys. They stay on the schema (optional) so a hobbyist dev env
  // without a data-provider can still fall back to the local manager.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_VISION_MODEL: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_VISION_MODEL: z.string().optional(),

  // Pricing + market data. Same note as AI — optional here; real keys live
  // on the data-provider.
  COINGECKO_API_KEY: z.string().optional(),
  FINNHUB_API_KEY: z.string().optional(),

  // EVM chains go through the data-provider (Etherscan V2 key lives there).
  // Optional at the backend schema now; only used by the local fallback
  // path that runs when SCANI_CLOUD_URL is unset.
  ETHERSCAN_API_KEY: z.string().optional(),

  // Object storage (Cloudflare R2 in prod, MinIO in dev) for screenshot
  // + file-import blobs. Optional at the backend schema: the storage-facade
  // in @scani/cloud-client transparently routes to the data-provider when
  // SCANI_CLOUD_URL is set; only the local-fallback dev path needs these.
  R2_ENDPOINT: z.string().url().optional(),
  R2_PUBLIC_ENDPOINT: z.string().url().optional(),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),

  // Sentry — required in prod once the Terraform provision lands. Left
  // optional at the schema level so dev boots without it; the SDK init
  // checks for DSN presence before enabling.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),

  // HMAC shared secret for admin → backend actions (BullMQ retry/remove,
  // DLQ replay). Required in prod.
  ADMIN_JOBS_HMAC_SECRET: requiredInProd(z.string().min(32), 'ADMIN_JOBS_HMAC_SECRET'),

  // Data-provider endpoint. Every outbound Scani-managed 3rd-party call
  // (pricing, AI, public chains, email, object storage, OG fetch) routes
  // through this host. Required in production across all three tiers:
  //  - Tier 1 / OSS:      http://data-provider:8082 (docker-compose)
  //  - Tier 2 / semi-mgd: https://api.cloud.scani.xyz (Scani-hosted)
  //  - Tier 3 / SaaS:     https://api.cloud.scani.xyz (internal key)
  // In dev it stays optional so a contributor can run backend without
  // booting the data-provider — the local fallback path takes over.
  SCANI_CLOUD_URL: isProduction ? httpsUrlInProduction : urlSchema.optional(),
  SCANI_CLOUD_API_KEY: requiredInProd(z.string().min(16), 'SCANI_CLOUD_API_KEY'),
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

  // Non-fatal warnings for prod: missing Sentry, missing AI fallbacks, etc.
  // Kept after the fatal parse so the issue list above stays compact.
  if (isProduction) {
    const warn = (msg: string) => console.warn(`⚠️  env: ${msg}`);
    if (!cached.SENTRY_DSN) warn('SENTRY_DSN unset — errors will not be reported to Sentry.');
    if (!cached.SCANI_CLOUD_URL)
      warn(
        'SCANI_CLOUD_URL unset — outbound 3rd-party calls will fall back to in-process providers.'
      );
  }

  return cached;
}
