/**
 * Thin wrapper around @sentry/node so backend + worker use identical init.
 *
 * `initSentry({ component, release })` is safe to call without awaiting —
 * if SENTRY_DSN is unset it's a no-op and the app runs fine. The env
 * schema emits a warning in production when DSN is missing.
 *
 * Bundling note: backend + worker pass `--external @sentry/* --external
 * @opentelemetry/*` to `bun build` so Sentry + its OTEL dependency are
 * resolved from `node_modules` at runtime, not inlined. This avoids a
 * Bun 1.3.11+ parser crash where OpenTelemetry's
 * `AsyncHooksContextManager._init` (class method) collides at bundle
 * scope with Sentry's `function _init` helper. See commit 0b119b6 for
 * the full autopsy.
 */

import * as Sentry from '@sentry/node';

let initialized = false;

export function initSentry(opts: {
  /** Tag emitted events so a shared Sentry project can filter backend vs worker vs data-provider. */
  component?: 'backend' | 'worker' | 'data-provider';
  release?: string;
}): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || initialized) return;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: opts.release || process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: 0.1,
    initialScope: opts.component ? { tags: { component: opts.component } } : undefined,
    integrations: (defaults) => defaults,
  });
  initialized = true;
}

/**
 * Flush pending events before process exit. Worker's SIGTERM handler and the
 * backend's graceful-shutdown path both call this; a 2s timeout is generous
 * enough to land the failing-job event that triggered the shutdown.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Never let a shutdown path throw because Sentry flushed slow.
  }
}

/** Capture exception only if Sentry is initialized; safe no-op otherwise. */
export function captureException(err: unknown, tags?: Record<string, string>): void {
  if (!initialized) return;
  try {
    Sentry.captureException(err, { tags });
  } catch {
    // Never let a Sentry capture failure fail the caller's error path.
  }
}

/**
 * Drop a breadcrumb on the active Sentry scope.
 *
 * Used by the cloud-client tRPC instrumentation to leave a trail of
 * data-provider calls (route + status + duration) so when the backend
 * later throws, the Sentry event carries the cloud-hop context.
 *
 * No-op when Sentry isn't initialized (dev / OSS without a DSN).
 */
export function addBreadcrumb(crumb: {
  category: string;
  message?: string;
  level?: 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
}): void {
  if (!initialized) return;
  try {
    Sentry.addBreadcrumb({
      category: crumb.category,
      message: crumb.message,
      level: crumb.level ?? 'info',
      data: crumb.data,
      timestamp: Date.now() / 1000,
    });
  } catch {
    // Never let a breadcrumb failure fail the caller.
  }
}

/** Capture a message event (non-error). */
export function captureMessage(msg: string, tags?: Record<string, string>): void {
  if (!initialized) return;
  try {
    Sentry.captureMessage(msg, { tags });
  } catch {
    // swallow
  }
}
