import { getNodeEnv } from '@scani/config';
import * as Sentry from '@sentry/node';

let initialized = false;

// Bot scans for `/.env`, `/.git/config`, `/favicon.ico`, etc. land on
// every public host. Sentry recorded ~50 such NOT_FOUND events across
// backend + data-provider in 2 weeks, drowning real errors. Drop them
// before they reach Sentry — they are background internet noise, not
// application bugs.
const BOT_SCAN_PATH =
  /\/(\.env|\.git|favicon|\.aws|\.well-known|wp-|wordpress|admin\.php|phpmyadmin)/i;

function isBotScanEvent(event: Sentry.Event): boolean {
  const url = event.request?.url || (event.tags as Record<string, string> | undefined)?.url || '';
  if (!url) return false;
  try {
    const path = url.startsWith('http') ? new URL(url).pathname : url;
    return BOT_SCAN_PATH.test(path);
  } catch {
    return BOT_SCAN_PATH.test(url);
  }
}

export function initSentry(opts: {
  component?: 'backend' | 'worker' | 'data-provider';
  release?: string;
}): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || initialized) return;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || getNodeEnv() || 'development',
    release: opts.release || process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: 0.1,
    initialScope: opts.component ? { tags: { component: opts.component } } : undefined,
    integrations: (defaults) => defaults,
    beforeSend(event) {
      if (isBotScanEvent(event)) return null;
      return event;
    },
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
