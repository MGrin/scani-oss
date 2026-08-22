import { checkEnvIsolatedUrl, isNodeEnvProduction, optionalUrl } from '@scani/config';
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
  // env schema. They are required HERE, in every deployment: the worker
  // boots `buildProviderRegistry({ mode: 'direct' })` unconditionally (see
  // src/index.ts) and calls these upstreams itself. Screenshot and document
  // parsing go through AIRouter -> the LOCAL ProviderRegistry, so a worker
  // without OPENAI_API_KEY throws on every parse rather than falling back
  // to the data-provider's `ai.*` routes — nothing routes there (SC-521).

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

  // Integrations whose lastSync is older than this many hours trigger a
  // Sentry alert via the stale-sync-probe processor. Default 3h keeps the
  // signal tight: exchange-balances runs hourly, so 3h means 2 missed cycles.
  STALE_SYNC_THRESHOLD_HOURS: z.coerce.number().int().positive().default(3),

  // How long an integration must have gone without syncing before its OWNER is
  // told (SC-459). Deliberately far above STALE_SYNC_THRESHOLD_HOURS above,
  // which is the same measurement for a different reader: 3h means two missed
  // hourly cycles, which is the right moment to page US and the wrong moment to
  // mail a user about a blip that will clear itself. 24h is a fault, not a
  // hiccup.
  ALERT_STALE_SYNC_HOURS: z.coerce.number().int().positive().default(24),

  // The two public origins the weekly digest puts in a letter (SC-460):
  // where "Open Scani" goes, and the api host serving the unsubscribe
  // endpoint. Both are absolute, because an email has no page to be relative
  // to.
  //
  // Named after the api's own two, and set from the same root `.env` lines,
  // because they are the same two URLs. `API_BASE_URL` was the obvious
  // alternative and is already taken: the e2e fixtures read it as the
  // Playwright target on port 3011.
  //
  // OPTIONAL — and so is SENTRY_DSN below, for the same reason, since SC-453.
  // (This comment used to read "unlike SENTRY_DSN below"; that contrast is
  // gone, not forgotten.) The worker runs every scheduled job in one binary,
  // so failing boot over a variable that one job needs takes the hourly
  // pricing, balance and reconcile jobs down with it.
  // `SendWeeklyDigestsUseCase` refuses loudly instead — a refusal an operator
  // can read, rather than 20 jobs that stopped. `SendIntegrationAlertsUseCase`
  // (SC-459) refuses the same way, and both are read by their processor rather
  // than by the use case.
  FRONTEND_URL: optionalUrl,
  BACKEND_URL: optionalUrl,

  // Sentry — optional, empty string treated as unset (see `optionalUrl`).
  // SDK init gates on DSN presence regardless.
  //
  // This was `requiredInProd` until SC-453, which is how the api and the
  // data-provider already had it before they were changed for exactly this
  // reason. The worker being the odd one out meant a self-hoster with no
  // Sentry account got a stack where everything came up healthy except the
  // worker, which restart-looped on a variable the compose file passes as
  // `${SENTRY_DSN:-}` — an empty string, which `requiredInProd` rejects.
  // Jobs then queue and never run, and nothing in the UI says why.
  // Managed deployments enforce the DSN in their own pipeline, not here.
  SENTRY_DSN: optionalUrl,
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),

  STUB_AI: isNodeEnvProduction()
    ? z.literal(undefined).optional()
    : z.union([z.literal('1'), z.literal('')]).optional(),

  // Test-only: when "1", chain activity probes and balance fetches
  // resolve from a local fixture instead of blockchain.info / Etherscan /
  // a Solana RPC. Refused in production — fixture balances shown to a
  // user would be worse than an outage, because they look like data.
  STUB_CHAIN_DATA: isNodeEnvProduction()
    ? z.literal(undefined).optional()
    : z.union([z.literal('1'), z.literal('')]).optional(),
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
