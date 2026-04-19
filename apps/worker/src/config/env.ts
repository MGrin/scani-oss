import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // When set, encrypted credentials in integration tables are decrypted with
  // this key. Required in production.
  ENCRYPTION_KEY: z.string().optional(),

  // Optional provider API keys — only used when EXTERNAL_API_MODE=direct.
  COINGECKO_API_KEY: z.string().optional(),
  FINNHUB_API_KEY: z.string().optional(),

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

  // R2 (Cloudflare Object Storage) for large job payloads (screenshots,
  // file-import blobs). Required whenever user-initiated jobs are enabled.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
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
  return cached;
}
