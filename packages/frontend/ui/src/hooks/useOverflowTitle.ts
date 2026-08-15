import { useEffect, useRef } from 'react';

/**
 * Make a truncated element's full text reachable by hovering it (SC-114).
 *
 * `/accounts` renders "Never — this accou…" in every row of the Last-synced
 * column. The real sentence is "Never — this account is maintained by hand",
 * which is *reassuring* — the account is manual by design, nothing is broken —
 * and the truncation inverts its meaning into what reads as a cut-off error.
 * There was no `title` on the cell or on any of its ancestors, so the full
 * string was unreachable anywhere in the product: the only way to read it was
 * to export the list.
 *
 * **Only when it actually overflows.** A `title` on every cell is a tooltip
 * that pops up over content the reader can already see, and it covers the row
 * below it while doing so. So the attribute is set from the measured overflow
 * rather than declared, and removed again when the column grows back — nothing
 * in React's tree knows how wide the text came out, so only the DOM can answer.
 *
 * After paint rather than before it (`useEffect`, not `useLayoutEffect`): the
 * attribute changes nothing visible, so there is no flash to avoid, and a
 * layout effect would warn on every server render of a list.
 *
 * No `ResizeObserver`: a list is hundreds of cells, an observer each is
 * hundreds of live observers for an attribute nobody may ever use. The sync
 * runs after every render of the cell — one batched read of `scrollWidth`, and
 * writing `title` cannot itself invalidate layout — plus on window resize,
 * which is the only other way the column width moves.
 */
export function useOverflowTitle<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const sync = () => {
      // A pixel of slack: sub-pixel layout rounds `scrollWidth` up on text that
      // fits exactly, which would put a tooltip on a cell showing everything.
      const truncated = element.scrollWidth > element.clientWidth + 1;
      const full = element.textContent?.trim() ?? '';
      if (truncated && full) {
        if (element.title !== full) element.title = full;
      } else if (element.title) {
        element.removeAttribute('title');
      }
    };

    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  });

  return ref;
}
