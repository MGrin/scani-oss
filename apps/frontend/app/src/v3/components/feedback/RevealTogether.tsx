import { useDelayedLoading } from '@scani/ui/v3/hooks/useDelayedLoading';
import { type Query, useIsFetching, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';

/** A query still on its FIRST load. A refresh of data already shown is not. */
const firstLoad = (query: Query) => query.state.data === undefined;

/** How long "nothing is loading" must hold before it is believed. */
const SETTLE_MS = 50;

/**
 * Shows a section once, together, rather than part by part (SC-1742).
 *
 * The children mount at once, so every query they own starts now, but they
 * stay hidden behind ONE skeleton while any query on the page is still on its
 * first load. They are revealed when none is, or at `capMs`, whichever comes
 * first, and never hidden again. A part still loading at the cap draws its
 * own placeholder in place: the cap is what keeps one slow query from holding
 * a whole page.
 *
 * The count is page-wide, not this subtree's: React Query cannot say which
 * component asked for a query. That only ever makes the reveal later, never
 * earlier, and the cap bounds it.
 *
 * The skeleton follows the §2.5 ramp: nothing for 300 ms, as everywhere else,
 * unless `skeletonRamps` says it carries a ramp of its own — a page whose
 * placeholder was already up before this mounted must not blank for 300 ms.
 * Either way it leaves in the same render the children arrive, so the two
 * are never on screen together.
 */
export function RevealTogether({
  capMs,
  skeleton,
  skeletonRamps = false,
  hold = false,
  onShown,
  children,
}: {
  /** Counted from when `hold` is released. */
  capMs: number;
  skeleton: ReactNode;
  /** The skeleton runs its own loading ramp: draw it from the first frame. */
  skeletonRamps?: boolean;
  /** Stay on the skeleton whatever is loading: the children cannot render
   *  yet. Lets a page keep ONE placeholder from its first frame to its
   *  reveal, rather than swap a second one in and restart its ramp. */
  hold?: boolean;
  onShown?: () => void;
  children: ReactNode;
}) {
  const client = useQueryClient();
  const pending = useIsFetching({ predicate: firstLoad });
  const [shown, setShown] = useState(false);

  // A zero is trusted only once it has held for `SETTLE_MS`. `pending` alone
  // reads zero on the first commit, before the children's queries exist; and
  // a section that asks a second question once its first is answered (the
  // household's accounts, after `household.mine`) reads zero for the moment
  // between the two. Revealing there let that section grow by 288 px.
  useEffect(() => {
    if (hold || shown || pending !== 0) return;
    const timer = setTimeout(() => {
      if (client.isFetching({ predicate: firstLoad }) === 0) setShown(true);
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [client, hold, pending, shown]);

  useEffect(() => {
    if (hold || shown) return;
    const timer = setTimeout(() => setShown(true), capMs);
    return () => clearTimeout(timer);
  }, [capMs, hold, shown]);

  useEffect(() => {
    if (shown) onShown?.();
  }, [shown, onShown]);

  const phase = useDelayedLoading(!shown);
  return (
    <>
      {shown || (phase === 'idle' && !skeletonRamps) ? null : skeleton}
      {/* `contents`, so the children still lay out in the parent's grid. */}
      <div data-reveal="" hidden={!shown} className={shown ? 'contents' : 'hidden'}>
        {children}
      </div>
    </>
  );
}
