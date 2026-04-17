import { z } from 'zod';

/**
 * Startup environment validation for the backend service.
 *
 * This schema is parsed once at boot. Missing or malformed environment
 * variables cause the process to exit with a clear error listing every
 * failing variable, instead of producing obscure runtime errors later.
 */

const isProduction = process.env.NODE_ENV === 'production';

const urlSchema = z.string().url({ message: 'must be a valid URL' });

const httpsUrlInProduction = isProduction
  ? urlSchema.refine((v) => v.startsWith('https://'), {
      message: 'must use https:// in production',
    })
  : urlSchema;

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

  // Optional external-API keys (used when EXTERNAL_API_MODE=direct).
  OPENAI_API_KEY: z.string().optional(),
  COINGECKO_API_KEY: z.string().optional(),
  FINNHUB_API_KEY: z.string().optional(),

  // Route external-API calls either directly to the upstream providers
  // (Tier 1 / Tier 3) or via the Scani-hosted proxy (Tier 2 — scani-cloud).
  EXTERNAL_API_MODE: z.enum(['direct', 'scani-cloud']).default('direct'),
  SCANI_CLOUD_API_URL: z.string().url().optional(),
  SCANI_CLOUD_CLIENT_TOKEN: z.string().optional(),
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
  return cached;
}
