import { z } from 'zod';

// Env shape owned by this package. `FLY_APP_NAME` is set by Fly on every
// machine; its presence is how inbound keying knows which headers a client
// could have forged (SC-1262).
//
// `SCANI_EDGE_SECRET` is the value Cloudflare adds as `x-scani-edge` on the
// way to a proxied api (SC-1264). Unset, nothing reads the header. With
// `SCANI_EDGE_LOCK=enforce` a request that reached Fly's public proxy without
// it is refused, which is what stops `*.fly.dev` bypassing Cloudflare.
const envSchema = z
  .object({
    FLY_APP_NAME: z.string().min(1).optional(),
    SCANI_EDGE_SECRET: z.string().min(32).optional(),
    SCANI_EDGE_LOCK: z.enum(['off', 'enforce']).default('off'),
  })
  .refine((env) => env.SCANI_EDGE_LOCK === 'off' || env.SCANI_EDGE_SECRET, {
    message: 'SCANI_EDGE_LOCK=enforce needs SCANI_EDGE_SECRET, or it refuses every request',
    path: ['SCANI_EDGE_LOCK'],
  });

export type RateLimiterConfig = z.infer<typeof envSchema>;

let cached: RateLimiterConfig | null = null;

export function loadRateLimiterConfig(env: NodeJS.ProcessEnv = process.env): RateLimiterConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`@scani/rate-limiter env misconfigured:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetRateLimiterConfig(): void {
  cached = null;
}
