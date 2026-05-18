import { z } from 'zod';

// Env shape owned by this package. Apps that depend on @scani/analytics
// don't redeclare these in their own env.ts schemas — they just set the
// vars; AnalyticsService / the email-tracking helpers self-validate on
// first use.
//
// Every field is optional: analytics is non-critical. When POSTHOG_KEY is
// unset the Node capture client no-ops, and when EMAIL_TRACKING_BASE_URL /
// EMAIL_TRACKING_SECRET are unset email HTML is sent unmodified. This lets
// dev, test, and OSS self-host boot with no PostHog account at all.
// Treat an empty string as "unset". CI secret-staging and `KEY=` lines in
// .env files surface as empty strings, not absent keys — without this,
// EMAIL_TRACKING_SECRET="" would fail .min(16) and crash boot.
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const envSchema = z.object({
  POSTHOG_KEY: optional(z.string()),
  POSTHOG_HOST: optional(z.string().url()),
  // Public origin that serves the /e/o and /e/c email-tracking routes —
  // the data-provider's public base URL in production.
  EMAIL_TRACKING_BASE_URL: optional(z.string().url()),
  // HMAC secret that signs email-tracking tokens so the pixel/redirect
  // endpoints can trust the messageId + recipient they decode.
  EMAIL_TRACKING_SECRET: optional(z.string().min(16)),
});

export type AnalyticsConfig = z.infer<typeof envSchema> & { POSTHOG_HOST: string };

const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com';

let cached: AnalyticsConfig | null = null;

export function loadAnalyticsConfig(env: NodeJS.ProcessEnv = process.env): AnalyticsConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`@scani/analytics env misconfigured:\n${issues}`);
  }
  cached = { ...parsed.data, POSTHOG_HOST: parsed.data.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST };
  return cached;
}

export function resetAnalyticsConfig(): void {
  cached = null;
}
