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

const envSchema = z
  .object({
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
      ? z
          .string()
          .min(32, { message: 'BETTER_AUTH_SECRET must be at least 32 chars in production' })
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

    // AI providers for screenshot parsing. At least one must be set in prod —
    // validated via a superRefine below so the error message lists all options.
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_VISION_MODEL: z.string().optional(),
    PERPLEXITY_API_KEY: z.string().optional(),
    DEEPSEEK_API_KEY: z.string().optional(),
    DEEPSEEK_VISION_MODEL: z.string().optional(),

    // Pricing + market data.
    COINGECKO_API_KEY: z.string().optional(),
    FINNHUB_API_KEY: z.string().optional(),

    // EVM chains use Etherscan's V2 multi-chain endpoint (one key covers all
    // chainIds). Non-EVM chains use their own public RPCs — no key needed.
    ETHERSCAN_API_KEY: requiredInProd(
      z.string().min(1, { message: 'ETHERSCAN_API_KEY is required for EVM wallet detection' })
    ),

    // Object storage (Cloudflare R2 in prod, MinIO in dev) for screenshot
    // + file-import blobs. Required in prod; the presign route and worker
    // reads both throw lazily if unset, making symptoms look like a code bug.
    // Either R2_ENDPOINT (full URL) or R2_ACCOUNT_ID (derives the Cloudflare
    // URL) must be set. R2_PUBLIC_ENDPOINT baked into presigned URLs for
    // the browser; defaults to R2_ENDPOINT when omitted.
    R2_ENDPOINT: z.string().url().optional(),
    R2_PUBLIC_ENDPOINT: z.string().url().optional(),
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: requiredInProd(z.string().min(1), 'R2_ACCESS_KEY_ID'),
    R2_SECRET_ACCESS_KEY: requiredInProd(z.string().min(1), 'R2_SECRET_ACCESS_KEY'),
    R2_BUCKET: requiredInProd(z.string().min(1), 'R2_BUCKET'),

    // Sentry — required in prod once the Terraform provision lands. Left
    // optional at the schema level so dev boots without it; the SDK init
    // checks for DSN presence before enabling.
    SENTRY_DSN: z.string().url().optional(),
    SENTRY_ENVIRONMENT: z.string().optional(),
    SENTRY_RELEASE: z.string().optional(),

    // HMAC shared secret for admin → backend actions (BullMQ retry/remove,
    // DLQ replay). Required in prod.
    ADMIN_JOBS_HMAC_SECRET: requiredInProd(z.string().min(32), 'ADMIN_JOBS_HMAC_SECRET'),

    // Route external-API calls either directly to the upstream providers
    // (Tier 1 / Tier 3) or via the Scani-hosted proxy (Tier 2 — scani-cloud).
    EXTERNAL_API_MODE: z.enum(['direct', 'scani-cloud']).default('direct'),
    SCANI_CLOUD_API_URL: z.string().url().optional(),
    SCANI_CLOUD_CLIENT_TOKEN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (!isProduction) return;
    const hasAnyAIKey = Boolean(
      env.OPENAI_API_KEY || env.PERPLEXITY_API_KEY || env.DEEPSEEK_API_KEY
    );
    if (!hasAnyAIKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message:
          'At least one AI provider key must be set in production (OPENAI_API_KEY, PERPLEXITY_API_KEY, or DEEPSEEK_API_KEY). Screenshot parsing requires one.',
      });
    }
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
    if (!cached.PERPLEXITY_API_KEY) warn('PERPLEXITY_API_KEY unset — no fallback if OpenAI fails.');
    if (!cached.DEEPSEEK_API_KEY) warn('DEEPSEEK_API_KEY unset — no secondary fallback.');
  }

  return cached;
}
