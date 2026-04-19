/**
 * Thin wrapper around @sentry/node for the backend boot sequence.
 *
 * Kept in apps/backend (not packages/core) because pulling @sentry/node into
 * the shared package's dependency graph produced a bundle that Bun 1.3.11+
 * refused to parse — opentelemetry's AsyncHooksContextManager._init method
 * and Sentry's module-level `function _init` helper landed in the same
 * bundle scope and tripped a "var shadows let/const/class" parser check.
 *
 * Call `initSentry({ release })` once at boot (after env.ts loads SENTRY_DSN).
 * If DSN is unset, init is a no-op — the app runs fine without Sentry; the
 * env schema logs a warning in production.
 */

import * as Sentry from '@sentry/node';

let initialized = false;

export function initSentry(opts: { release?: string }): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || initialized) return;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: opts.release || process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: 0.1,
    initialScope: { tags: { component: 'backend' } },
    integrations: (defaults) => defaults,
  });
  initialized = true;
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Never let a shutdown path throw because Sentry flushed slow.
  }
}

export function captureException(err: unknown, tags?: Record<string, string>): void {
  if (!initialized) return;
  try {
    Sentry.captureException(err, { tags });
  } catch {
    // Never let a Sentry capture failure fail the caller's error path.
  }
}

export function captureMessage(msg: string, tags?: Record<string, string>): void {
  if (!initialized) return;
  try {
    Sentry.captureMessage(msg, { tags });
  } catch {
    // swallow
  }
}
