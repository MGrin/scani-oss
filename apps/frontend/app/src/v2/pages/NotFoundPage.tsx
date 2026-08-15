import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Compass } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { V2_ROUTES } from '../lib/routes';

/**
 * What `/v2/<anything unrouted>` renders (SC-73).
 *
 * It rendered nothing at all before this. v2's route table is a single
 * `<Routes>` with no catch-all, so a path that matches none of its entries
 * matched the `AppShell` layout route's *children* not at all — and a layout
 * route with no matching child renders `null`. Not an error boundary, not a
 * console message, not even the shell: a white page.
 *
 * On desktop that is a typo you fix in the address bar. In the installed PWA
 * it is unrecoverable. There is no address bar, no back button and no browser
 * chrome, so a stale bookmark or a link from an old email is a dead app the
 * user can only escape by force-quitting — and it is reachable without a typo,
 * because v3's own catch-all forwards everything it does not route to
 * `/v2/<same path>` on the assumption that v2 will show something.
 *
 * So the page has three jobs, in this order:
 *
 * 1. **Render inside `AppShell`.** It is registered as a child of the layout
 *    route rather than beside it, so the sidebar and the tab bar come with it.
 *    That alone ends the dead end — every destination in the app is one tap
 *    away before the reader has read a word.
 * 2. **Say what happened, with the path in it.** "Page not found" leaves the
 *    reader guessing whether the app is broken or the link was; the address
 *    they asked for, quoted back, answers that without them opening devtools.
 * 3. **Offer the two exits that are not the shell.** The dashboard, and the
 *    new interface at the same address — the second matters because the most
 *    likely way to arrive here is a v3 path that v3 does not route either, and
 *    the reader may simply be on the wrong side of the split.
 *
 * SC-71 fixed `/files` by adding that one route. This is the general case it
 * left; v2 is deliberately touched here, because it is still the fallback UI
 * for the whole app and a dead end in a PWA is not survivable.
 */
export function NotFoundPage() {
  const { pathname, search } = useLocation();
  // v2 lives under `/v2`, so the same screen in the new interface is this
  // address with the prefix taken off. `|| '/'` for `/v2` itself, which cannot
  // reach this page today but would stop being a valid URL if it could.
  const inV3 = `${pathname.replace(/^\/v2/, '') || '/'}${search}`;

  return (
    <div className="mx-auto w-full max-w-2xl px-0 py-2 sm:px-4 sm:py-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Compass className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            This page doesn&apos;t exist
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Nothing in Scani is at{' '}
            <span className="break-all font-mono text-foreground">{`${pathname}${search}`}</span>.
            The link may be out of date, or the address may have a typo in it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to={V2_ROUTES.dashboard}>Go to the dashboard</Link>
            </Button>
            {/* A plain anchor, not a `<Link>`: crossing the v2/v3 split changes
                which shell is mounted, and `UiVersionGate` reads the stored
                preference on mount. A client-side navigation would leave the
                classic shell wrapped around a v3 route. */}
            <Button asChild variant="outline">
              <a href={inV3}>Try it in the new interface</a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
