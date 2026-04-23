import { httpsUrlInProduction, isProduction, requiredInProd, urlSchema } from '@scani/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // When set, encrypted credentials in integration tables are decrypted with
  // this key. MUST match the backend's ENCRYPTION_KEY exactly — if they
  // disagree, every stored credential becomes unreadable on the worker side.
  ENCRYPTION_KEY: isProduction
    ? z.string().min(32, { message: 'ENCRYPTION_KEY must be at least 32 chars in production' })
    : z.string().optional(),

  // AI / pricing / chain provider keys are all optional here: in prod the
  // data-provider carries them. The local fallback paths in @scani/domain
  // still honour these if SCANI_CLOUD_URL is unset (dev / self-hosted OSS
  // without a data-provider sidecar).
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_VISION_MODEL: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_VISION_MODEL: z.string().optional(),

  COINGECKO_API_KEY: z.string().optional(),
  FINNHUB_API_KEY: z.string().optional(),

  ETHERSCAN_API_KEY: z.string().optional(),

  // Data-provider endpoint — required in production across all three tiers.
  // See apps/backend/src/config/env.ts for the full contract and tier
  // matrix. Optional in dev so a contributor can run the worker without
  // booting the data-provider sidecar. Mirror the backend's shape: https://
  // enforced in prod so 3rd-party calls don't leak plaintext over the wire.
  SCANI_CLOUD_URL: isProduction ? httpsUrlInProduction : urlSchema.optional(),
  SCANI_CLOUD_API_KEY: requiredInProd(z.string().min(16), 'SCANI_CLOUD_API_KEY'),

  // Worker concurrency — how many jobs per processor run in parallel.
  // Default 4 so user-initiated jobs don't queue up behind scheduled cron
  // fire-ups. Bump higher on dedicated workers with Redis headroom.
  WORKER_CONCURRENCY: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : 4))
    .refine((n) => Number.isFinite(n) && n > 0, { message: 'must be a positive integer' }),

  // R2/MinIO now lives in the data-provider. Kept optional here only for
  // the local fallback path (dev without data-provider sidecar).
  R2_ENDPOINT: z.string().url().optional(),
  R2_PUBLIC_ENDPOINT: z.string().url().optional(),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),

  // Sentry — optional at schema level; SDK init gates on DSN presence.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),
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
    if (!cached.SCANI_CLOUD_URL)
      warn(
        'SCANI_CLOUD_URL unset — outbound 3rd-party calls will fall back to in-process providers.'
      );
  }

  return cached;
}
