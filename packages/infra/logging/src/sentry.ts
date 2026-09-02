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

/**
 * Run `fn` inside a Sentry span, or run it plainly when Sentry is not
 * initialized.
 *
 * WHY A SERVER SPAN HAS TO BE ASKED FOR BY HAND HERE (SC-751). `@sentry/node`'s
 * default HTTP instrumentation patches `node:http`, and these services are
 * served by Elysia on `Bun.serve`, which does not go through it. So there is no
 * `http.server` transaction for an incoming request and nothing for a child
 * span to hang off — a span asked for here is not extra detail on top of a
 * request trace, it is the ONLY trace there is.
 *
 * Measured 2026-08-28 against a local envelope sink rather than read off the
 * code, because a span that is never recorded and a request that never happened
 * transmit the same nothing: a request served by `Bun.serve` with the SDK's
 * default integrations installed produced NO transaction envelope, while an
 * explicit span in the same process produced one. `sentry-span-over-bun-serve`
 * pins both halves.
 *
 * The one thing that did show up on the project before this — better-auth's
 * routes — is not a counter-example: better-auth ships its own OpenTelemetry
 * instrumentation, which Sentry adopts. Nothing patched the HTTP layer.
 *
 * A `source` is set because without one Sentry treats the name as a low-quality
 * `custom` one and may cluster it. It defaults to `route` — every caller until
 * SC-822 named a bounded server route — and `task` is for a background job,
 * which has no route to name. Set here rather than at each call site so
 * `@sentry/node` stays imported in exactly this file (`@scani/logging/sentry`
 * is the wrapper every backend reaches Sentry through).
 *
 * THE QUEUE WORKER HAS NO SOURCE OF SPANS AT ALL, WHICH IS A HARDER ZERO THAN
 * THE ONE ABOVE (SC-822). `Bun.serve` at least produces requests the SDK could
 * have instrumented; a BullMQ consumer is not an HTTP server, so there is no
 * transport for anything to patch — a deployment can therefore report errors
 * normally and no performance data whatsoever, with nothing in its
 * configuration looking wrong. `@scani/queue`'s dispatch calls this for every
 * job, which is what closes it.
 */
export function withSpan<T>(
  span: { name: string; op: string; source?: 'route' | 'task' },
  fn: () => T
): T {
  if (!initialized) return fn();
  return Sentry.startSpan(
    {
      name: span.name,
      op: span.op,
      attributes: {
        [Sentry.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: span.source ?? 'route',
        [Sentry.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: 'manual',
      },
    },
    fn
  );
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
