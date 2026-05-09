import { z } from 'zod';

export const isProduction = process.env.NODE_ENV === 'production';

export const urlSchema = z.string().url({ message: 'must be a valid URL' });

// The refine reads NODE_ENV at parse time (not at module load) so a single
// schema instance handles both dev and prod. In real apps NODE_ENV is stable
// from boot, so this is behaviourally identical to a load-time gate; the
// payoff is that tests can exercise both branches in one process.
export const httpsUrlInProduction = urlSchema.refine(
  (v) => process.env.NODE_ENV !== 'production' || v.startsWith('https://'),
  { message: 'must use https:// in production' }
);

export function requiredInProd<T extends z.ZodString>(
  schema: T,
  varName?: string
): T | z.ZodOptional<T> {
  if (process.env.NODE_ENV !== 'production') return schema.optional();
  if (!varName) return schema;
  // Re-applying min(1) lets us name the variable in the error message;
  // zod's stock "must be at least 1 chars" hides which env var failed.
  return schema.min(1, {
    message: `${varName} is required in production and cannot be empty`,
  }) as unknown as T;
}

/**
 * Cross-environment-isolation guard for shared infrastructure URLs
 * (Redis, Postgres). The threat: a developer's local stack picking up
 * a prod URL by accident, or a misconfigured CI job pointing at a
 * shared instance. BullMQ in particular shares its Redis prefix
 * across every connection, so a stray dev process pulling jobs from
 * the prod queue would silently process real user data.
 *
 * Heuristic: if the URL contains the substring `localhost`, `127.0.0.1`,
 * or `:6379` (the default Redis port commonly used in compose), it's
 * a dev URL. Any other host is treated as remote/prod. We don't
 * accept "looks like prod" matches because vendor URLs vary
 * (`*.upstash.io`, `*.neon.tech`, `*.fly.dev`). Instead the rule is
 * simple: production NODE_ENV must NOT see a localhost-style URL,
 * and non-production must NOT see a non-localhost URL — unless the
 * caller explicitly opts out (e.g. for an integration test that
 * spins up its own remote stack).
 *
 * @returns the URL if it passes the env consistency check
 * @throws  Error with a loud message if it doesn't
 */
export function assertEnvIsolatedUrl(opts: {
  url: string;
  varName: string;
  /** Override NODE_ENV detection — useful for tests. */
  isProduction?: boolean;
  /** Caller opt-out (e.g. integration test against a real Redis). */
  allowCrossEnv?: boolean;
}): string {
  if (opts.allowCrossEnv) return opts.url;
  const inProd = opts.isProduction ?? process.env.NODE_ENV === 'production';
  // Host-based detection only. The previous version included `:6379` as
  // a "looks local" signal, but real Upstash production URLs commonly
  // use port 6379 too (e.g. `rediss://...@*.upstash.io:6379`), which
  // false-positived the guard and caused boot crashes on
  // data-provider / api / worker. Dropping the port pattern entirely;
  // host strings cover every local-stack case we actually care about.
  const looksLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal/i.test(opts.url);
  if (inProd && looksLocal) {
    throw new Error(
      `${opts.varName} appears to be a local URL (${redactUrlForLog(opts.url)}) but NODE_ENV=production. ` +
        'Refusing to boot — set the production URL or unset NODE_ENV.'
    );
  }
  if (!inProd && !looksLocal) {
    throw new Error(
      `${opts.varName} appears to be a remote URL (${redactUrlForLog(opts.url)}) but NODE_ENV=${process.env.NODE_ENV ?? '<unset>'}. ` +
        'Refusing to boot — point at a local instance or set NODE_ENV=production.'
    );
  }
  return opts.url;
}

function redactUrlForLog(url: string): string {
  // Hide credentials in log lines.
  return url.replace(/\/\/[^:]+:[^@]+@/, '//<redacted>@');
}
