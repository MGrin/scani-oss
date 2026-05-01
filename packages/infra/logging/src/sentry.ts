import * as Sentry from '@sentry/node';

let initialized = false;

export function initSentry(opts: {
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

// 2s is generous enough to land the failing-job event that triggered the
// shutdown, but not long enough to keep Fly's SIGTERM grace timer waiting.
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // A shutdown path must never throw because Sentry flushed slowly.
  }
}

export function captureException(err: unknown, tags?: Record<string, string>): void {
  if (!initialized) return;
  try {
    Sentry.captureException(err, { tags });
  } catch {
    // A failing Sentry capture must not bubble into the caller's error path.
  }
}

// Used by cloud-client tRPC instrumentation to leave a trail of
// data-provider calls (route + status + duration). When the backend
// later throws, the Sentry event carries the cloud-hop context.
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
    // Breadcrumb failures must not bubble into the caller.
  }
}
