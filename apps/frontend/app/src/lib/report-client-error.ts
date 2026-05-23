/**
 * Fire-and-forget client error reporting.
 *
 * Posts errors caught by V2ErrorBoundary (and anywhere else that wants to
 * log a crash) to the backend `clientErrors.report` tRPC procedure.
 *
 * Uses `fetch` directly rather than the tRPC React client because error
 * boundaries run outside the React tree and must be callable from anywhere.
 *
 * Silently swallows all failures — an error-reporting path that can itself
 * throw creates infinite loops on already-broken UIs.
 */

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
    const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:3001';
    const url = `${apiBase}/trpc/clientErrors.report`;

    const payload = {
      message: truncate(input.error.message, MAX_MESSAGE_LEN) ?? 'Unknown error',
      stack: truncate(input.error.stack, MAX_STACK_LEN),
      componentStack: truncate(input.componentStack, MAX_COMPONENT_STACK_LEN),
      route:
        typeof window !== 'undefined'
          ? `${window.location.pathname}${window.location.search}`
          : undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      appVersion: import.meta.env.VITE_APP_VERSION as string | undefined,
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
