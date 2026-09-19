import { z } from 'zod';

// Env shape owned by this package. `FLY_APP_NAME` is set by Fly on every
// machine; its presence is how inbound keying knows which headers a client
// could have forged (SC-1262).
const envSchema = z.object({
  FLY_APP_NAME: z.string().min(1).optional(),
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
