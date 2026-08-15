import type { ReactNode } from 'react';
import type { LoadingPhase } from '../../lib/loading';

/**
 * What each band of the §2.5 ramp actually draws.
 *
 * The container owns the accessibility, not the placeholder: one `role="status"
 * aria-busy` region announcing "Loading holdings" once, with every decorative
 * shape inside it `aria-hidden`. Skeletons that each carry their own `aria-busy`
 * make a screen reader read six rectangles.
 *
 * `stalled` is the timeout fallback the ticket asks for. The shimmer stops —
 * `data-v3-loading="stalled"` is what `styles/v3-motion.css` hangs that off,
 * because the animation belongs to `Skeleton` in `@scani/ui` and v3 may not
 * reach into it — and a line of text says the wait is no longer normal. A
 * placeholder that pulses for five minutes is an interface asserting something
 * it does not know.
 */

interface LoadingRampProps {
  phase: LoadingPhase;
  /** Shaped like the layout that is coming. Rendered from the `skeleton` band. */
  skeleton: ReactNode;
  /** Lowercase, plural — "holdings". Reaches a screen reader, never the screen. */
  label: string;
  /** Offered on `stalled`, where the wait has stopped being credible. */
  onRetry?: () => void;
}

export function LoadingRamp({ phase, skeleton, label, onRetry }: LoadingRampProps) {
  if (phase === 'idle') return null;

  return (
    <div role="status" aria-busy="true" data-v3-loading={phase} className="flex flex-col gap-3">
      <span className="sr-only">Loading {label}</span>

      {phase === 'indicator' ? (
        // The 300ms–1s band. A 2px rail rather than a spinner or a partial
        // skeleton: it acknowledges the tap without claiming to know what
        // shape the answer is, and it occupies a height the arriving content
        // does not have to fight for.
        <div aria-hidden="true" className="h-0.5 overflow-hidden rounded-full bg-muted">
          <span className="v3-loading-rail block h-full w-1/3 rounded-full bg-primary" />
        </div>
      ) : (
        <div aria-hidden="true">{skeleton}</div>
      )}

      {phase === 'stalled' ? (
        <div className="flex flex-wrap items-center gap-3 px-4">
          <p className="text-caption text-muted-foreground">
            Still waiting on the server. Nothing has been changed.
          </p>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-md border border-border-strong px-2 py-1 text-caption transition-colors duration-fast ease-emphasized hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
