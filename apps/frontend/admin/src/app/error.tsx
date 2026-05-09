'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Sentry's Next.js SDK auto-captures errors that propagate to the
    // segment-level error boundary, so we only need to log for local
    // visibility — no manual `Sentry.captureException` here.
    console.error('[admin] segment-level error caught by error boundary', error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-xl font-semibold text-foreground">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          The admin dashboard hit an unexpected error. The team has been notified.
          {error.digest ? (
            <span className="block mt-2 font-mono text-xs">id: {error.digest}</span>
          ) : null}
        </p>
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
