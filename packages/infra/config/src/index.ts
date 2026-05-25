import { z } from 'zod';

/**
 * Read NODE_ENV at runtime, not build time.
 *
 * `bun build --compile --minify` statically substitutes literal
 * `process.env.NODE_ENV` accesses with the build-time value (defaults
 * to `"development"` when unset). Bracket notation defeats that
 * inlining so the compiled binary reads the actual OS env at runtime.
 *
 * EVERY check that needs the runtime NODE_ENV value MUST use this
 * helper, not the literal `process.env.NODE_ENV` form. Otherwise the
 * check is silently dead in the compiled binary.
 *
 * See OSS-QA-REPORT-POST-FIX.md N-1 for the smoking-gun reproducer.
 */
export function getNodeEnv(): string | undefined {
  // biome-ignore lint/complexity/useLiteralKeys: bracket notation defeats bun's build-time inlining
  return process.env['NODE_ENV'];
}

export function isNodeEnvProduction(): boolean {
  return getNodeEnv() === 'production';
}

/**
 * @deprecated Module-load-time snapshot — keeps back-compat for existing
 * imports, but new code should call `isNodeEnvProduction()` so the value
 * is read at the call site rather than at module-load.
 */
export const isProduction = isNodeEnvProduction();

export const urlSchema = z.string().url({ message: 'must be a valid URL' });

// The refine reads NODE_ENV at parse time (not at module load) so a single
// schema instance handles both dev and prod. In real apps NODE_ENV is stable
// from boot, so this is behaviourally identical to a load-time gate; the
// payoff is that tests can exercise both branches in one process.
export const httpsUrlInProduction = urlSchema.refine(
  (v) => !isNodeEnvProduction() || v.startsWith('https://'),
  { message: 'must use https:// in production' }
);

/**
 * Optional URL that treats empty string the same as unset (undefined).
 *
 * Solves the common docker-compose footgun: a compose file with
 * `SENTRY_DSN: ${SENTRY_DSN:-}` passes the literal empty string `""` to
 * the container when the env var is unset in `.env`. A plain
 * `z.string().url().optional()` then rejects `""` as "Invalid url",
 * crashing boot for any operator who hasn't opted into the optional
 * feature.
 *
 * `optionalUrl` accepts: `undefined`, `""`, or any valid URL. Empty
 * string is preprocessed to `undefined` so downstream consumers see a
 * single "unset" shape rather than having to also check for the empty
 * string sentinel.
 */
export const optionalUrl = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().url({ message: 'must be a valid URL or empty/unset' }).optional()
);

export function requiredInProd<T extends z.ZodString>(
  schema: T,
  varName?: string
): T | z.ZodOptional<T> {
  if (!isNodeEnvProduction()) return schema.optional();
  if (!varName) return schema;
  // Re-applying min(1) lets us name the variable in the error message;
  // zod's stock "must be at least 1 chars" hides which env var failed.
  return schema.min(1, {
    message: `${varName} is required in production and cannot be empty`,
  }) as unknown as T;
}

/**
 * Cross-environment-isolation check for shared infrastructure URLs
 * (Redis, Postgres). The threat: a developer's local stack picking up
 * a prod URL by accident, or a misconfigured CI job pointing at a
 * shared instance. BullMQ in particular shares its Redis prefix
 * across every connection, so a stray dev process pulling jobs from
 * the prod queue would silently process real user data.
 *
 * Heuristic: if the URL contains the substring `localhost`,
 * `127.0.0.1`, `0.0.0.0`, or `host.docker.internal`, it's a dev URL.
 * Any other host is treated as remote/prod. We don't accept "looks
 * like prod" matches because vendor URLs vary (`*.upstash.io`,
 * `*.neon.tech`, `*.fly.dev`). Instead the rule is simple:
 * production NODE_ENV should NOT see a localhost-style URL, and
 * non-production should NOT see a non-localhost URL — unless the
 * caller explicitly opts out.
 *
 * Returns a structured `{ ok, reason? }` result rather than throwing.
 * The on-call lesson from the 2026-05-09 outage: a guard that calls
 * `process.exit(1)` from module-load code turns a transient or
 * mis-detected env into a hard-down. Callers should warn (and
 * surface via /readyz) instead.
 */
export interface EnvIsolatedUrlCheck {
  ok: boolean;
  /** Human-readable explanation when `ok=false`. URL is redacted. */
  reason?: string;
}

export function checkEnvIsolatedUrl(opts: {
  url: string;
  varName: string;
  /** Override NODE_ENV detection — useful for tests. */
  isProduction?: boolean;
  /** Caller opt-out (e.g. integration test against a real Redis). */
  allowCrossEnv?: boolean;
}): EnvIsolatedUrlCheck {
  if (opts.allowCrossEnv) return { ok: true };
  const inProd = opts.isProduction ?? isNodeEnvProduction();
  // Host-based detection only. The previous version included `:6379` as
  // a "looks local" signal, but real Upstash production URLs commonly
  // use port 6379 too (e.g. `rediss://...@*.upstash.io:6379`), which
  // false-positived the guard. Host strings cover every local-stack
  // case we actually care about.
  const looksLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal/i.test(opts.url);
  if (inProd && looksLocal) {
    return {
      ok: false,
      reason:
        `${opts.varName} appears to be a local URL (${redactUrlForLog(opts.url)}) but NODE_ENV=production. ` +
        'Set the production URL or unset NODE_ENV.',
    };
  }
  if (!inProd && !looksLocal) {
    return {
      ok: false,
      reason:
        `${opts.varName} appears to be a remote URL (${redactUrlForLog(opts.url)}) but NODE_ENV=${getNodeEnv() ?? '<unset>'}. ` +
        'Point at a local instance or set NODE_ENV=production.',
    };
  }
  return { ok: true };
}

/**
 * @deprecated Throws on mismatch — DO NOT call from boot paths. Use
 * `checkEnvIsolatedUrl` and warn / report via /readyz instead. Kept
 * for any test that still expects the throw shape.
 *
 * Kept exported so the contract stays in the package barrel; callers
 * are migrated app-by-app to `checkEnvIsolatedUrl`.
 */
export function assertEnvIsolatedUrl(opts: {
  url: string;
  varName: string;
  isProduction?: boolean;
  allowCrossEnv?: boolean;
}): string {
  const result = checkEnvIsolatedUrl(opts);
  if (!result.ok) {
    throw new Error(`${result.reason} Refusing to boot.`);
  }
  return opts.url;
}

function redactUrlForLog(url: string): string {
  // Hide credentials in log lines. The character classes exclude '/' and
  // bound the userinfo length so a pathological '////…' input can't drive
  // polynomial backtracking (CodeQL js/polynomial-redos). Userinfo per
  // RFC 3986 cannot contain '/' or '@' anyway.
  return url.replace(/\/\/[^:/@]{1,256}:[^@/]{1,256}@/, '//<redacted>@');
}
