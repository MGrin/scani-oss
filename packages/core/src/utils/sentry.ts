/**
 * Thin wrapper around @sentry/node so backend + worker use identical init.
 *
 * Call `initSentry({ component, release })` once at boot (after env.ts loads
 * SENTRY_DSN). If DSN is unset, init is a no-op — the app runs fine without
 * Sentry; the env schema logs a warning in production.
 */

import type * as SentryType from '@sentry/node';

let SentryMod: typeof SentryType | undefined;

export async function initSentry(opts: {
  component: 'backend' | 'worker';
  release?: string;
}): Promise<typeof SentryType | undefined> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return undefined;

  // Deferred import so test/CI environments that don't have @sentry/node
  // installed don't crash at module load time.
  SentryMod = await import('@sentry/node');
  SentryMod.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: opts.release || process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: 0.1,
    // Attach the component as a tag so a single Sentry search can filter to
    // "everything the worker is seeing" vs "everything the backend is seeing"
    // even though they share an org.
    initialScope: { tags: { component: opts.component } },
    // Bun's process.on() for 'uncaughtException' works; keep this default on.
    integrations: (defaults) => defaults,
  });
  return SentryMod;
}

/**
 * Flush pending events before process exit. Worker's SIGTERM handler and the
 * backend's graceful-shutdown path both call this; a 2s timeout is generous
 * enough to land the failing-job event that triggered the shutdown.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!SentryMod) return;
  try {
    await SentryMod.flush(timeoutMs);
  } catch {
    // Never let a shutdown path throw because Sentry flushed slow.
  }
}

/** Capture exception only if Sentry is initialized; safe no-op otherwise. */
export function captureException(err: unknown, tags?: Record<string, string>): void {
  if (!SentryMod) return;
  try {
    SentryMod.captureException(err, { tags });
  } catch {
    // Never let a Sentry capture failure fail the caller's error path.
  }
}

/** Capture a message event (non-error). */
export function captureMessage(msg: string, tags?: Record<string, string>): void {
  if (!SentryMod) return;
  try {
    SentryMod.captureMessage(msg, { tags });
  } catch {
    // swallow
  }
}
