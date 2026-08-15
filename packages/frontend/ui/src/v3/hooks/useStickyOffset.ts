import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Publishes a sticky element's height as `--v3-list-sticky` on a root the
 * content underneath can read (SC-71 8.4).
 *
 * A sticky header covers whatever scrolls under it — that is the deal, and it
 * is fine while the reader is doing the scrolling, because they can see where
 * things went. It stops being fine the moment the *browser* scrolls: Tab onto a
 * row below the fold, a restored scroll position, any `scrollIntoView`, and the
 * row lands flush against the top of the scroller with the toolbar drawn over
 * it. On `/holdings` with search open that leaves a row showing its name and
 * its delta and nothing where its value should be.
 *
 * `scroll-margin-top` on the rows is the fix, and the number has to be
 * measured: the toolbar grows a second line when filter chips appear and a
 * third when they wrap. Measured rather than assumed is also why this is a hook
 * and not a constant — a constant would be right until the first surface with
 * two active filters.
 *
 * Written as a CSS variable rather than as React state so a resize repaints
 * without re-rendering a list that may hold two hundred rows.
 */
export interface StickyOffset {
  /** The element the variable is written on. Rows must be inside it. */
  rootRef: (node: HTMLElement | null) => void;
  /** The sticky element being measured. */
  barRef: (node: HTMLElement | null) => void;
}

export const STICKY_OFFSET_VAR = '--v3-list-sticky';

export function useStickyOffset(): StickyOffset {
  const root = useRef<HTMLElement | null>(null);
  const bar = useRef<HTMLElement | null>(null);
  const [, setAttached] = useState(0);

  const publish = useCallback(() => {
    if (!root.current) return;
    const height = bar.current?.offsetHeight ?? 0;
    root.current.style.setProperty(STICKY_OFFSET_VAR, `${height}px`);
  }, []);

  useEffect(() => {
    publish();
    const node = bar.current;
    // No `ResizeObserver` in the static-render environment the v3 tests use,
    // and nothing to observe there either — `renderToStaticMarkup` produces no
    // layout at all.
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => observer.disconnect();
  });

  return {
    rootRef: useCallback(
      (node: HTMLElement | null) => {
        root.current = node;
        publish();
      },
      [publish]
    ),
    barRef: useCallback((node: HTMLElement | null) => {
      bar.current = node;
      // The bar mounts and unmounts with the toolbar, which is conditional on
      // the surface having anything to refine. A render is what re-runs the
      // effect above against the new node.
      setAttached((n) => n + 1);
    }, []),
  };
}
