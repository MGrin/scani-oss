import { isNodeEnvProduction, requiredInProd, urlSchema } from '@scani/config';
import { z } from 'zod';

// Env shape owned by this package. Apps that depend on @scani/cloud-client
// don't redeclare these in their own env.ts schemas — they just set the
// env vars and the runtime / health-probe / facades resolve the config
// lazily on first use.
//
// SCANI_CLOUD_URL is optional in dev/test (apps fall back to in-process
// providers / local services). In production it must be a valid URL,
// and `https://` is the default — except when the hostname has no dots
// (a docker-compose service name like `data-provider`) or ends in a
// known private suffix (`.internal`, `.local`). Those are
// unreachable from the public internet and forcing TLS on them would
// require an internal TLS-terminating sidecar nobody actually wants.
// Public hostnames still require https://.
//
// SCANI_CLOUD_API_KEY is required-in-prod via @scani/config's helper.

/**
 * True when the hostname is reachable only inside a private network —
 * compose service alias (no dots), or `.internal` / `.local` suffix.
 * Used to allow plain http:// for these hosts even in production.
 * Exported for unit testing.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  if (!hostname.includes('.')) return true;
  return hostname.endsWith('.internal') || hostname.endsWith('.local');
}

// NODE_ENV is read at parse time (not at module load) so tests can
// exercise both production and non-production branches against the
// same schema instance — same pattern as `httpsUrlInProduction` in
// @scani/config. We MUST use `isNodeEnvProduction()` (bracket-notation
// access) here, not the literal `process.env.NODE_ENV` form: `bun build
// --compile --minify` statically inlines the literal at build time,
// silently making this guard dead in the compiled binary.
const cloudUrlSchema = urlSchema.optional().superRefine((value, ctx) => {
  if (!isNodeEnvProduction()) return; // dev/test: anything goes (including unset)
  if (value === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'is required in production',
    });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'must be a valid URL',
    });
    return;
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && isPrivateNetworkHost(parsed.hostname)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      'must use https:// in production. http:// is only allowed for compose-network hostnames (no DNS dots) and the .internal / .local private suffixes.',
  });
});

const envSchema = z.object({
  SCANI_CLOUD_URL: cloudUrlSchema,
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
