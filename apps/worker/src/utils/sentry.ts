/**
 * Thin wrapper around @sentry/node for the worker boot sequence. See the
 * backend's apps/backend/src/utils/sentry.ts for the rationale behind
 * keeping this per-app rather than in packages/core.
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
    initialScope: { tags: { component: 'worker' } },
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
    // swallow
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
