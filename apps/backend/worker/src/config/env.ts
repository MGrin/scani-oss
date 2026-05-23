import { checkEnvIsolatedUrl, optionalUrl } from '@scani/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // ENCRYPTION_KEY is owned by @scani/security's own env schema. The worker
  // and api both depend on @scani/security; the package validates the key
  // on first encrypt/decrypt call. Both sides MUST share the same key —
  // else stored credentials become unreadable on the worker side.

  // Per-provider API keys (OPENAI / COINGECKO /
  // FINNHUB / ETHERSCAN / HELIUS / GOOGLE_*) are owned by @scani/providers'
  // env schema; only required on whichever host boots in `direct` mode.

  // SCANI_CLOUD_URL + SCANI_CLOUD_API_KEY are owned by @scani/cloud-client's
  // own env schema. Required in prod; optional in dev (local fallback).

  // Worker concurrency — how many jobs run in parallel across the
  // worker. Default 4 so user-initiated jobs don't queue up behind
  // scheduled cron fire-ups. Bump higher on dedicated workers with
  // Redis headroom.
  WORKER_CONCURRENCY: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : 4))
    .refine((n) => Number.isFinite(n) && n > 0, { message: 'must be a positive integer' }),

  // Sub-cap on how many *scheduled* (cron-triggered) jobs may run in
  // parallel. The hourly tide of pricing + wallet-balances + exchange-
  // balances all firing at minute 0 used to take three concurrency
  // slots, leaving only one for any user-initiated work that landed
  // in the same minute. Default = ceil(WORKER_CONCURRENCY/2) reserves
  // half the budget for user jobs without starving crons. Set to 0 (or
  // ≥ WORKER_CONCURRENCY) to disable the cap entirely.
  WORKER_CONCURRENCY_CRON: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : undefined))
    .refine((n) => n === undefined || (Number.isFinite(n) && n >= 0), {
      message: 'WORKER_CONCURRENCY_CRON must be a non-negative integer',
    }),

  // Object storage (S3_*) is owned by @scani/storage's own env schema; the
  // worker only sees it via the cloud-client storage-facade's local-mode
  // fallback when SCANI_CLOUD_URL is unset.

  // Above this DLQ depth the dlq-depth-probe processor escalates to
  // Sentry. 50 is the historical default; tune via env without a code
  // change. Validated up-front so a typo (`fifty`) doesn't silently
  // fall back to the default.
  DLQ_ALERT_THRESHOLD: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : 50))
    .refine((n) => Number.isFinite(n) && n > 0, {
      message: 'DLQ_ALERT_THRESHOLD must be a positive integer',
    }),

  // Sentry — fully optional. Empty string is treated as unset (see
  // `optionalUrl`). SDK init gates on DSN presence regardless.
  SENTRY_DSN: optionalUrl,
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
  // Env-isolation check: warn-only, never exit. See api/data-provider
  // env.ts for the full rationale.
  const redisCheck = checkEnvIsolatedUrl({ url: cached.REDIS_URL, varName: 'REDIS_URL' });
  if (!redisCheck.ok) {
    console.warn(`⚠️  env-isolation: ${redisCheck.reason}`);
  }
  const dbCheck = checkEnvIsolatedUrl({ url: cached.DATABASE_URL, varName: 'DATABASE_URL' });
  if (!dbCheck.ok) {
    console.warn(`⚠️  env-isolation: ${dbCheck.reason}`);
  }
  return cached;
}
