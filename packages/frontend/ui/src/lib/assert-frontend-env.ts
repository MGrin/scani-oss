/**
 * Boot-time validation for the runtime URLs each frontend app needs.
 *
 * Why this exists: Vite resolves `import.meta.env.VITE_*` at build time.
 * If the build pipeline forgets to stage a required value, the deployed
 * bundle silently inlines `undefined`, the consumer falls back to a
 * `localhost:3001` default, and the production app appears to "load"
 * but every tRPC call hits an unreachable origin. Every minute spent
 * debugging "why does prod 5xx" is paid in user trust.
 *
 * Behaviour:
 *  - In production (`import.meta.env.PROD`), missing or malformed URLs
 *    throw immediately. The caller is expected to render a static error
 *    page instead of mounting React; otherwise the app boots into a
 *    broken state and the user sees a blank screen.
 *  - In dev / test, the helper logs a warning and returns the input as
 *    a string so contributors can boot without ceremony.
 */
export interface FrontendEnvSpec {
  /** Variable name as it appears in `import.meta.env`. */
  name: string;
  /** Raw value pulled from `import.meta.env`. */
  value: unknown;
  /**
   * Required URLs MUST parse via `new URL(...)`. Optional URLs may be
   * empty / undefined (e.g. a same-origin fallback path).
   */
  required: boolean;
  /**
   * Allowed protocols for the URL. Defaults to `['https:']` in
   * production and `['http:', 'https:']` everywhere else.
   */
  allowedProtocols?: readonly string[];
  /**
   * Accept a root-relative path (`/api`) as well as an absolute URL.
   *
   * The published `scani/frontend-app` image is built with
   * `VITE_API_URL=/api` so that ONE artefact serves any hostname — nginx
   * inside it proxies `/api/` to `API_UPSTREAM` and the browser never learns
   * the backend's address. Without this flag that value fails `new URL(raw)`
   * and this function throws during module evaluation of `main.tsx`, which is
   * a blank page with no error boundary above it and no network request to
   * look at (SC-467, measured against the published 0.13.0 image).
   *
   * Off by default, and deliberately per-spec: `VITE_SENTRY_DSN` has no
   * same-origin meaning, and accepting `/whatever` for it would turn a
   * misconfiguration into a silent no-op.
   */
  allowSameOriginPath?: boolean;
}

export interface AssertFrontendEnvOptions {
  /** Override `import.meta.env.PROD`. Useful in tests. */
  isProduction?: boolean;
}

export function assertFrontendEnv(
  specs: readonly FrontendEnvSpec[],
  opts: AssertFrontendEnvOptions = {}
): void {
  // `import.meta.env.PROD` is typed boolean by Vite's client.d.ts but
  // this package isn't a Vite app — it's a library consumed by Vite
  // apps — so the global env shape here is the unrefined
  // `Record<string, string | undefined>`. Treat truthy strings as prod.
  const envProd = (import.meta as { env?: Record<string, unknown> }).env?.PROD;
  const isProduction =
    opts.isProduction ?? (envProd === true || envProd === 'true' || envProd === '1');

  const errors: string[] = [];

  for (const spec of specs) {
    const raw = spec.value;
    const isMissing = raw == null || (typeof raw === 'string' && raw.length === 0);

    if (isMissing) {
      if (spec.required && isProduction) {
        errors.push(`${spec.name} is required in production but is missing`);
      }
      continue;
    }

    if (typeof raw !== 'string') {
      errors.push(`${spec.name} must be a string (got ${typeof raw})`);
      continue;
    }

    // A root-relative path is same-origin by construction, so there is no
    // protocol to check and nothing the protocol rule below could say about
    // it: it inherits the page's, which is https wherever that matters.
    if (spec.allowSameOriginPath && raw.startsWith('/') && !raw.startsWith('//')) {
      continue;
    }

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      errors.push(
        `${spec.name} must be a valid URL${spec.allowSameOriginPath ? ' or a root-relative path' : ''} (got ${truncate(raw)})`
      );
      continue;
    }

    const protocols = spec.allowedProtocols ?? (isProduction ? ['https:'] : ['http:', 'https:']);
    if (!protocols.includes(parsed.protocol)) {
      errors.push(`${spec.name} must use one of ${protocols.join(' / ')} (got ${parsed.protocol})`);
    }
  }

  if (errors.length === 0) return;

  const summary = errors.map((e) => `  - ${e}`).join('\n');
  if (isProduction) {
    throw new Error(`Frontend env misconfigured:\n${summary}`);
  }
  // eslint-disable-next-line no-console
  console.warn(`[scani] Frontend env warnings (dev mode, non-fatal):\n${summary}`);
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
