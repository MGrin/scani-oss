/**
 * Fire-and-forget client error reporting, for errors an error boundary caught
 * before Sentry's global handler could see them.
 *
 * With the browser Sentry client active the error goes to Sentry directly, so
 * it lands in the frontend project with its own stack (SC-1492). Without one —
 * a self-hosted build with no DSN — it is posted to the api's
 * `clientErrors.report` relay instead, never both.
 *
 * The relay uses `fetch` directly rather than the tRPC React client because
 * error boundaries run outside the React tree.
 *
 * Silently swallows all failures — an error-reporting path that can itself
 * throw creates infinite loops on already-broken UIs.
 */

import { isChunkLoadError } from '@scani/ui/lib/lazy-chunk';
import * as Sentry from '@sentry/react';

const MAX_MESSAGE_LEN = 2000;
const MAX_STACK_LEN = 8000;
const MAX_COMPONENT_STACK_LEN = 8000;

function truncate(s: string | undefined | null, max: number): string | undefined {
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

export interface ReportClientErrorInput {
  error: Error;
  componentStack?: string;
}

export async function reportClientError(input: ReportClientErrorInput): Promise<void> {
  try {
    // The path only: a query string can carry a magic-link token (SC-1350).
    const route = typeof window !== 'undefined' ? window.location.pathname : undefined;
    // A chunk that would not load is the network or a deploy, not a bug in
    // this code, so it is filed below an error (SC-1380).
    const chunkFailure = isChunkLoadError(input.error);

    if (Sentry.getClient()) {
      Sentry.captureException(input.error, {
        level: chunkFailure ? 'warning' : 'error',
        tags: route ? { route } : undefined,
        contexts: input.componentStack
          ? { react: { componentStack: input.componentStack } }
          : undefined,
      });
      return;
    }

    const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:3001';
    const url = `${apiBase}/trpc/clientErrors.report`;

    const payload = {
      message: truncate(input.error.message, MAX_MESSAGE_LEN) ?? 'Unknown error',
      stack: truncate(input.error.stack, MAX_STACK_LEN),
      componentStack: truncate(input.componentStack, MAX_COMPONENT_STACK_LEN),
      route,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      appVersion: import.meta.env.VITE_APP_VERSION as string | undefined,
      level: chunkFailure ? ('warning' as const) : undefined,
    };

    // tRPC v10 accepts raw JSON for non-batched mutations.
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // Credentials omitted — this is a public endpoint and we want this
      // request to succeed even when auth is broken.
      keepalive: true,
    });
  } catch {
    // Intentionally swallow. The UI already crashed; we can't make it worse.
  }
}
