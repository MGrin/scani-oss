import { Alert, AlertDescription, AlertTitle } from '@scani/ui/ui/alert';
import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';

export interface ErrorPanelProps {
  /** Human-readable subject — usually the service name ("Sentry", "Cloudflare"). */
  service: string;
  /** Error from the upstream call. Coerced to string for display. */
  error: unknown;
  /** Optional follow-up text below the error (e.g. "Re-issue the token in the vendor console"). */
  hint?: ReactNode;
}

/**
 * Surfaces a service-level failure inside the same `Alert` primitive
 * every other Scani frontend uses. Replaces the old hand-rolled
 * red-border box; the import path is kept stable so existing pages don't
 * need updates.
 */
export function ErrorPanel({ service, error, hint }: ErrorPanelProps) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{service} unavailable</AlertTitle>
      <AlertDescription>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] opacity-90">
          {message}
        </pre>
        {hint ? <div className="mt-2 text-xs opacity-80">{hint}</div> : null}
      </AlertDescription>
    </Alert>
  );
}
