import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { type Location, useLocation } from 'react-router-dom';
import { runViewTransition, shouldTransitionRoute } from '../lib/view-transition';

/**
 * The location `<Routes>` should render, deferred by one commit whenever that
 * commit is worth animating.
 *
 * react-router 6.30's own `unstable_viewTransition` only exists on the data
 * routers; this app is a plain `<BrowserRouter>`, so the integration is ours.
 * It is the documented shape of one, and it is small: hold the location being
 * shown, and when the router moves to a new one, apply it inside
 * `document.startViewTransition`.
 *
 * The one-commit lag is the mechanism, not a bug: for the duration of the
 * transition the URL is the new one and the tree is still the old one, which
 * is exactly the pair the browser is cross-fading.
 */
export function useViewTransitionLocation(): Location {
  const location = useLocation();
  const [shown, setShown] = useState<Location>(location);

  useEffect(() => {
    if (shown.key === location.key) return;
    if (!shouldTransitionRoute(shown.pathname, location.pathname)) {
      setShown(location);
      return;
    }
    runViewTransition(() => setShown(location), flushSync);
  }, [location, shown.key, shown.pathname]);

  return shown;
}
