import { isProduction } from '@scani/config';
import { z } from 'zod';

// Env shape owned by this package. Apps that depend on @scani/security don't
// declare ENCRYPTION_KEY in their own env.ts schemas — they just set the env
// var and the encryption helpers self-validate on first call.
//
// Production: ENCRYPTION_KEY is required and must be ≥32 chars. Without it
// `encrypt`/`encryptCredentials` would silently fall back to writing
// plaintext through the dev-mode passthrough; refusing to load the config
// is the only safe behaviour.
//
// Dev / test: optional. The encryption helpers passthrough to plaintext so
// docker-compose stacks and IntegrationCredentialsService.test.ts run
// without ceremony.
const envSchema = z.object({
  ENCRYPTION_KEY: isProduction
    ? z.string().min(32, {
        message:
          'ENCRYPTION_KEY is required in production and must be at least 32 chars. ' +
          'Refusing to store sensitive data without encryption.',
      })
    : z.string().min(1).optional(),
});

export type SecurityConfig = z.infer<typeof envSchema>;

let cached: SecurityConfig | null = null;

export function loadSecurityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`@scani/security env misconfigured:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetSecurityConfig(): void {
  cached = null;
}
