import { isProduction, requiredInProd } from '@scani/config';
import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),

    // When set, encrypted credentials in integration tables are decrypted with
    // this key. MUST match the backend's ENCRYPTION_KEY exactly — if they
    // disagree, every stored credential becomes unreadable on the worker side.
    ENCRYPTION_KEY: isProduction
      ? z.string().min(32, { message: 'ENCRYPTION_KEY must be at least 32 chars in production' })
      : z.string().optional(),

    // AI providers for screenshot parsing. At least one must be set in prod.
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_VISION_MODEL: z.string().optional(),
    PERPLEXITY_API_KEY: z.string().optional(),
    DEEPSEEK_API_KEY: z.string().optional(),
    DEEPSEEK_VISION_MODEL: z.string().optional(),

    COINGECKO_API_KEY: z.string().optional(),
    FINNHUB_API_KEY: z.string().optional(),

    // EVM chains via Etherscan V2 (one key all chainIds). Non-EVM use public RPCs.
    ETHERSCAN_API_KEY: requiredInProd(z.string().min(1), 'ETHERSCAN_API_KEY'),

    EXTERNAL_API_MODE: z.enum(['direct', 'scani-cloud']).default('direct'),
    SCANI_CLOUD_API_URL: z.string().url().optional(),
    SCANI_CLOUD_CLIENT_TOKEN: z.string().optional(),

    // Worker concurrency — how many jobs per processor run in parallel.
    // Default 4 so user-initiated jobs don't queue up behind scheduled cron
    // fire-ups. Bump higher on dedicated workers with Redis headroom.
    WORKER_CONCURRENCY: z
      .string()
      .optional()
      .transform((v) => (v ? Number.parseInt(v, 10) : 4))
      .refine((n) => Number.isFinite(n) && n > 0, { message: 'must be a positive integer' }),

    // Object storage (R2 in prod, MinIO in dev) for reading blobs the
    // backend uploaded. Required in prod. See backend env.ts for the
    // full contract.
    R2_ENDPOINT: z.string().url().optional(),
    R2_PUBLIC_ENDPOINT: z.string().url().optional(),
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: requiredInProd(z.string().min(1), 'R2_ACCESS_KEY_ID'),
    R2_SECRET_ACCESS_KEY: requiredInProd(z.string().min(1), 'R2_SECRET_ACCESS_KEY'),
    R2_BUCKET: requiredInProd(z.string().min(1), 'R2_BUCKET'),

    // Sentry — optional at schema level; SDK init gates on DSN presence.
    SENTRY_DSN: z.string().url().optional(),
    SENTRY_ENVIRONMENT: z.string().optional(),
    SENTRY_RELEASE: z.string().optional(),
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
          'At least one AI provider key must be set in production (OPENAI_API_KEY, PERPLEXITY_API_KEY, or DEEPSEEK_API_KEY).',
      });
    }
  });

export type WorkerEnv = z.infer<typeof envSchema>;

let cached: WorkerEnv | undefined;

export function loadEnv(): WorkerEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    console.error(`\n❌ Invalid worker environment:\n${issues}\n`);
    process.exit(1);
  }
  cached = parsed.data;

  if (isProduction) {
    const warn = (msg: string) => console.warn(`⚠️  env: ${msg}`);
    if (!cached.SENTRY_DSN) warn('SENTRY_DSN unset — errors will not be reported to Sentry.');
    if (!cached.PERPLEXITY_API_KEY) warn('PERPLEXITY_API_KEY unset — no fallback if OpenAI fails.');
    if (!cached.DEEPSEEK_API_KEY) warn('DEEPSEEK_API_KEY unset — no secondary fallback.');
  }

  return cached;
}
