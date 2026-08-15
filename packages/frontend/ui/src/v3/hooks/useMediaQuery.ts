import { useEffect, useState } from 'react';

/**
 * `lg` in Tailwind's default scale, which is where v3 stops offering the row
 * list and starts offering the table. One literal, because a breakpoint that
 * lives in both a class name and a JS string drifts.
 */
export const DESKTOP_QUERY = '(min-width: 1024px)';

function evaluate(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

/**
 * A media query as state.
 *
 * v3 picks between the row list and the table in JS rather than rendering both
 * behind `hidden lg:block`, because the CSS version mounts every row twice —
 * two DOM trees, two sets of handlers, and a 200-row list paying for a table
 * nobody on a phone can see.
 *
 * The initial value is read synchronously in the `useState` initialiser rather
 * than in an effect, so a desktop load paints the table on the first frame
 * instead of flashing the phone list. There is no SSR here (Vite SPA); the
 * `window` guard is for `renderToStaticMarkup` in the tests, where "no window"
 * correctly resolves to the phone surface — which is the one v3 is designed
 * against.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => evaluate(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    // Re-read on mount: the query can have changed between the initialiser and
    // the effect if `query` itself changed.
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}
