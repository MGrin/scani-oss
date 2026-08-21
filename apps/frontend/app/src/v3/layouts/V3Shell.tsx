import { ThemeToggle } from '@scani/ui/components/ThemeToggle';
import { useSheetRoute } from '@scani/ui/v3/hooks/useSheetRoute';
import { CAPTURE_SHEET, MORE_SHEET } from '@scani/ui/v3/lib/sheet';
import { useCallback, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useVisualViewportShell } from '@/hooks/useVisualViewportShell';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useReviewFeed } from '@/v3/hooks/useReviewFeed';
import { CaptureSheet } from '../components/capture/CaptureSheet';
import { CaptureSheetProvider } from '../components/capture/CaptureSheetContext';
import { DemoBanner } from '../components/DemoBanner';
import { PullToRefreshIndicator } from '../components/PullToRefreshIndicator';
import { V3TokenScope } from '../components/V3TokenScope';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { resolveActiveTabPath, resolveActiveV3Path } from '../lib/routes';
import { V3MoreDrawer } from './V3MoreDrawer';
import { V3Sidebar } from './V3Sidebar';
import { V3_TAB_BAR_SPACER, V3TabBar } from './V3TabBar';

/**
 * The v3 root. `V3TokenScope` renders the `data-ui="v3"` element the v3 token
 * block hangs off (V3-03) — which is what keeps the new surface ramp,
 * gain/loss tokens and type scale from reaching v2 — and publishes it as the
 * portal container, so overlays land inside the scope rather than on
 * `document.body` (V3-22).
 *
 * Two navigation surfaces, not one responsive compromise: a five-slot tab
 * bar plus a snap-point drawer below `lg`, a grouped sidebar above it.
 * They share one route table (`lib/routes.ts`) and one active-path rule,
 * so they cannot disagree about where the user is.
 *
 * `useReviewFeed` comes from v2 unchanged — it is the single source for
 * "how many things need the user's attention" and the reasoning in its
 * doc comment (server-side filtering, because the paginated job list
 * silently under-counts) applies identically here.
 */
export function V3Shell() {
  const { pathname, search } = useLocation();
  const { signOut } = useAuth();
  const { count: actionRequiredCount } = useReviewFeed();
  // Both sheets are `?sheet=` on the screen they open over, not component
  // state (SC-67). They still open *over* the page and closing still returns
  // the user to it untouched — the pathname never changes, so the route below
  // is never unmounted — but the browser's Back now closes the sheet instead
  // of navigating the page underneath it.
  const more = useSheetRoute(MORE_SHEET);
  const capture = useSheetRoute(CAPTURE_SHEET);
  const openCapture = capture.open;

  const activePath = resolveActiveV3Path(pathname);
  // The query string, not just the path: holdings narrowed to one account is a
  // drill-down inside the Accounts tab and has to keep it lit (V3-40).
  const activeTabPath = resolveActiveTabPath(pathname, search);

  // Pull-to-refresh refetches; it does not reload. `location.reload()` in an
  // installed PWA throws away the router, the shell and every warm cache to
  // answer a question — "is this still true?" — that invalidation answers
  // without the white screen. `utils.invalidate()` marks the whole tRPC cache
  // stale, which refetches exactly the queries this route has mounted and
  // leaves the rest to refetch when something asks for them.
  const scrollerRef = useRef<HTMLElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  useVisualViewportShell(shellRef);
  const utils = trpc.useUtils();
  const refresh = useCallback(() => utils.invalidate(), [utils]);
  const pull = usePullToRefresh(scrollerRef, refresh);

  return (
    <V3TokenScope
      rootRef={shellRef}
      // A column, so the demo label can span the sidebar as well as the
      // content — it is a statement about the deployment, not about the page.
      // `DemoBanner` renders null everywhere else, so this is one empty flex
      // child on every other deployment and nothing moves (SC-466).
      className="flex h-dvh flex-col overflow-hidden bg-background text-foreground"
      // `InstallPromptBanner` and `UpdateBanner` are `fixed top-0` and are
      // mounted above the router, so they cover whatever the current shell
      // puts at the top of the screen. They already publish their height for
      // exactly this reason (`useBannerOffset`); reading it here is what
      // keeps the header visible instead of hidden behind a banner.
      style={{ paddingTop: 'var(--scani-banner-offset, 0px)' }}
    >
      <DemoBanner />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <V3Sidebar
          activePath={activePath}
          actionRequiredCount={actionRequiredCount}
          onCapturePress={openCapture}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <header
            className="flex shrink-0 items-center gap-2 border-b border-border px-4 lg:hidden"
            style={{
              paddingTop: 'env(safe-area-inset-top)',
              minHeight: 'calc(3.5rem + env(safe-area-inset-top))',
            }}
          >
            {/* The "v3" chip that sat here is gone (V3-19) — see `V3Sidebar`. */}
            <span className="text-title">Scani</span>
            <div className="ml-auto flex items-center gap-1">
              <ThemeToggle variant="icon" side="bottom" align="end" />
            </div>
          </header>

          {/* The pull indicator is positioned against this wrapper rather than
              against `<main>` itself: `<main>` is the route-transition region,
              and anything inside it is captured in the snapshot and cross-fades
              with the page. It is also the scroller, so a child of it would
              scroll away mid-refresh. `overflow-hidden` is what lets the chip
              start off the top edge instead of over the header. */}
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <PullToRefreshIndicator
              distance={pull.distance}
              phase={pull.phase}
              progress={pull.progress}
            />

            {/* `data-v3-route-region` is the only element in v3 carrying a
                `view-transition-name` (styles/v3-motion.css). Naming the content
                region is what holds the tab bar, the sidebar and this header
                still while the page under them changes — an unnamed document
                cross-fades the chrome with an identical copy of itself. */}
            {/* `relative` is load-bearing, and the reason is not obvious.

                Tailwind's `sr-only` is `position: absolute`. An absolutely
                positioned element is laid out against its nearest *positioned*
                ancestor, and is clipped by that ancestor's overflow — not by an
                unpositioned one. With nothing positioned between a screen-reader
                label and the document, every `sr-only` span in a long list
                resolved against the initial containing block, escaped this
                element's `overflow-y: auto`, and extended the *document*.
                Measured on production at 1200×874 with 69 holdings:
                `documentElement.scrollHeight` 4250 against a `body` of 874, so
                the whole shell — sidebar included — scrolled away and left the
                bare `<body>` showing under it. Positioning this element makes it
                the containing block, so those spans are clipped here and the
                document stops growing.

                `overscroll-none` is the other half: it stops a rubber-band at
                either end of this scroller from chaining to the document, where
                `<body>` is painted by `globals.css` from *v2's* `--background`
                (measured `rgb(10,10,10)` against this tree's `rgb(13,14,17)`)
                and reads as a seam. It is also what makes the pull unambiguous:
                a gesture this shell has claimed must not also move the page
                behind it. */}
            <main
              className={cn(
                'relative min-h-0 flex-1 overflow-y-auto overscroll-none',
                'ease-emphasized duration-base',
                // Easing the page while the finger is on it would be lag; easing
                // it on release is the settle.
                pull.phase === 'pulling' || pull.phase === 'ready' ? '' : 'transition-transform'
              )}
              data-scrollable="true"
              data-v3-route-region="true"
              ref={scrollerRef}
              // The page follows the finger. A chip that descends over a still
              // page reads as a badge stuck to the content — on the home screen
              // it lands on the net-worth figure. Moving the page is what makes
              // the gap the chip lives in, and is what every phone list does.
              //
              // `undefined` at rest, not `translateY(0)`: a transform that is
              // always present makes this element the containing block for any
              // `position: fixed` descendant, which would silently anchor a
              // future fixed bar inside a page to the scroller instead of the
              // viewport. It only exists while the gesture does.
              style={
                pull.distance > 0 ? { transform: `translateY(${pull.distance}px)` } : undefined
              }
            >
              {/* The opener reaches the outlet so an empty screen can carry the
                  capture sheet as its call to action — which is the place it is
                  worth the most. */}
              <CaptureSheetProvider value={openCapture}>
                <Outlet />
              </CaptureSheetProvider>
              {/* The tab bar is fixed to the viewport so it cannot drift with
                  dvh shifts; this reserves the height it covers. */}
              <div aria-hidden="true" className="lg:hidden" style={{ height: V3_TAB_BAR_SPACER }} />
            </main>
          </div>
        </div>
      </div>

      <V3TabBar
        activeTabPath={activeTabPath}
        onCapturePress={openCapture}
        onMorePress={more.open}
        actionRequiredCount={actionRequiredCount}
      />
      <CaptureSheet open={capture.isOpen} onOpenChange={capture.setOpen} />
      <V3MoreDrawer
        open={more.isOpen}
        onOpenChange={more.setOpen}
        activePath={activePath}
        actionRequiredCount={actionRequiredCount}
        onSignOut={() => void signOut()}
      />
    </V3TokenScope>
  );
}
