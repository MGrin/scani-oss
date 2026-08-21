import { isDemoModeRequested, isNodeEnvProduction, urlSchema } from '@scani/config';
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
// SCANI_CLOUD_API_KEY is required in production for the same reason and by
// the same rule.
//
// ## The one production deployment with no data-provider at all (SC-516)
//
// `demo.scani.xyz` prices nothing, syncs nothing and mails nobody — every
// quote it shows was seeded, every account it shows was invented, and it has
// no sign-in to mail a code for. It ran a data-provider anyway, purely to give
// these two variables something true to point at, and that service was two Fly
// machines and four secrets held for the sake of a schema.
//
// So demo mode is the carve-out, by name, and nothing else is: with
// `SCANI_DEMO_MODE=1` both variables may be absent in production, and
// `getCloudClient()` then returns null, which is the local-fallback path the
// facades already implement and `probeDataProvider` already no-ops on.
//
// It does not weaken the production guard, because demo mode cannot be turned
// on in production: `assertDemoOnlyDatabase` reads every email in `users` at
// boot and exits unless the demo persona is alone there (SC-466). An operator
// who set the flag on `app.scani.xyz` to dodge this check would take the
// process down rather than boot it without a data-provider.
//
// Setting the variables in demo mode is still checked, not ignored — a demo
// carrying `https://api.cloud.scani.xyz` is exactly the copied-from-production
// config `scripts/lib/demo-isolation.ts` exists to catch, and it would be
// perverse for the schema to stop looking at a value the moment it is most
// suspicious.

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

/**
 * Whether a *present* `SCANI_CLOUD_URL` may be dialled by a production
 * process. A value zod's `.url()` already rejected returns true here: its
 * shape error is reported by the field, and adding a second, different
 * complaint about the same variable helps nobody.
 */
function isProductionSafeCloudUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return true;
  }
  return parsed.protocol === 'https:' || isPrivateNetworkHost(parsed.hostname);
}

// NODE_ENV is read at parse time (not at module load) so tests can
// exercise both production and non-production branches against the
// same schema instance — same pattern as `httpsUrlInProduction` in
// @scani/config. We MUST use `isNodeEnvProduction()` (bracket-notation
// access) here, not the literal `process.env.NODE_ENV` form: `bun build
// --compile --minify` statically inlines the literal at build time,
// silently making this guard dead in the compiled binary.
//
// The production rules live on the OBJECT rather than on each field because
// they now depend on a sibling variable (`SCANI_DEMO_MODE`), which a
// field-level refinement cannot see. That also moves the API-key requirement
// from `requiredInProd` — which resolves required-vs-optional at MODULE LOAD —
// to parse time, so it is finally reachable from a test process whose own
// NODE_ENV is `test`. The old file said in a comment that it was not.
const envSchema = z
  .object({
    SCANI_CLOUD_URL: urlSchema.optional(),
    SCANI_CLOUD_API_KEY: z.string().min(16).optional(),
    SCANI_DEMO_MODE: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (!isNodeEnvProduction()) return; // dev/test: anything goes (including unset)

    const demo = isDemoModeRequested(env);

    if (env.SCANI_CLOUD_URL === undefined) {
      if (!demo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SCANI_CLOUD_URL'],
          message: 'is required in production',
        });
      }
    } else if (!isProductionSafeCloudUrl(env.SCANI_CLOUD_URL)) {
      // Present, so it is dialled — checked whether or not this is a demo.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SCANI_CLOUD_URL'],
        message:
          'must use https:// in production. http:// is only allowed for compose-network hostnames (no DNS dots) and the .internal / .local private suffixes.',
      });
    }

    if (env.SCANI_CLOUD_API_KEY === undefined && !demo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SCANI_CLOUD_API_KEY'],
        message: 'SCANI_CLOUD_API_KEY is required in production and cannot be empty',
      });
    }
  })
  .transform(({ SCANI_CLOUD_URL, SCANI_CLOUD_API_KEY }) => ({
    SCANI_CLOUD_URL,
    SCANI_CLOUD_API_KEY,
  }));

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
