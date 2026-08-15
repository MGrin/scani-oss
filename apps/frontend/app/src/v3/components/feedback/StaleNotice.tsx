import { Button } from '@scani/ui/ui/button';
import { CloudOff } from 'lucide-react';

/**
 * Says that the figures on screen are the last ones we had, rather than the
 * current ones (SC-71 9.1).
 *
 * `<QueryError>` is the state for a read that failed with nothing to fall back
 * on; this is the state for a read that failed *behind data already drawn* —
 * which is the one v3 was quietly getting wrong. With the api unreachable the
 * home screen rendered a full portfolio, to the cent, with nothing anywhere
 * saying it was a cached answer. A figure that might be days old and a figure
 * that is live are not the same claim, and the reader has no way to tell them
 * apart from the inside.
 *
 * Deliberately a line rather than a banner: it must be legible without being
 * the thing the reader looks at, because in the overwhelmingly common case the
 * cached figures are also the right ones and the correct reaction is to carry
 * on. `role="status"` for the same reason — this is not an alert, it is a
 * qualification on everything below it.
 */
export function StaleNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed border-border-strong px-3 py-2"
    >
      <CloudOff className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-caption text-muted-foreground">
        Couldn't reach Scani. These are the last figures we had, not today's.
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
