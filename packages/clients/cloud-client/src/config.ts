import { httpsUrlInProduction, isProduction, requiredInProd, urlSchema } from '@scani/config';
import { z } from 'zod';

// Env shape owned by this package. Apps that depend on @scani/cloud-client
// don't redeclare these in their own env.ts schemas — they just set the
// env vars and the runtime / health-probe / facades resolve the config
// lazily on first use.
//
// SCANI_CLOUD_URL is optional in dev/test (apps fall back to in-process
// providers / local services) and required-with-https in production.
// SCANI_CLOUD_API_KEY is required-in-prod via @scani/config's helper.
const envSchema = z.object({
  SCANI_CLOUD_URL: isProduction ? httpsUrlInProduction : urlSchema.optional(),
  SCANI_CLOUD_API_KEY: requiredInProd(z.string().min(16), 'SCANI_CLOUD_API_KEY'),
});

export type CloudClientConfig = z.infer<typeof envSchema>;

let cached: CloudClientConfig | null = null;

export function loadCloudClientConfig(env: NodeJS.ProcessEnv = process.env): CloudClientConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`@scani/cloud-client env misconfigured:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetCloudClientConfig(): void {
  cached = null;
}
