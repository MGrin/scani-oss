import { AlertTriangle } from 'lucide-react';
import { Button } from '../../../ui/button';
import { describeQueryError } from '../../lib/errors';

/**
 * The one error surface every v3 read renders.
 *
 * The copy comes from `lib/errors.ts` so the §2.5 voice rules are decided in a
 * pure function and asserted in a test rather than retyped per screen — which
 * is how "Something went wrong" ends up in an app that has a rule against it.
 *
 * `Retry` is a real button wired to `refetch`, not a suggestion to reload the
 * page — the distinction §2.5 draws, and the reason the state takes an
 * `onRetry` rather than rendering a link to the current URL.
 */

interface QueryErrorProps {
  error: unknown;
  /** What failed to load, lowercase — "your portfolio", "upcoming payments". */
  subject: string;
  onRetry: () => void;
}

export function QueryError({ error, subject, onRetry }: QueryErrorProps) {
  const copy = describeQueryError(error, subject);

  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-lg border border-border-strong bg-surface-1 p-4"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-loss" aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-label text-foreground">{copy.title}</p>
          <p className="text-body text-muted-foreground">{copy.detail}</p>
        </div>
      </div>
      <Button variant="outline" onClick={onRetry}>
        {copy.retryLabel}
      </Button>
    </div>
  );
}
