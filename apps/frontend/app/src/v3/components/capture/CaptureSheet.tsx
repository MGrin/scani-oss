import {
  BottomDrawer,
  BottomDrawerBody,
  BottomDrawerContent,
  BottomDrawerDescription,
  BottomDrawerHeader,
  BottomDrawerTitle,
} from '@scani/ui/ui/bottom-drawer';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@scani/ui/ui/sheet';
import { useIsDesktop } from '@scani/ui/v3/hooks/useMediaQuery';
import {
  ChevronRight,
  FileText,
  FileUp,
  Image,
  Keyboard,
  type LucideIcon,
  Plug,
  Repeat,
  Wallet,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import {
  CAPTURE_GROUPS,
  type CaptureRoute,
  captureContextQuery,
  captureHref,
} from '../../lib/capture';

/**
 * How data gets in — the centre tab, and a menu rather than a page.
 *
 * The two-shell split is `PeekSheet`'s, unchanged and for the same reason: a
 * half-height drawer is a thumb idiom, and on a 1440px screen the same content
 * belongs in a right-side panel. Both are Radix dialogs, so one list serves
 * both and only the frame differs.
 *
 * It rests at 85% rather than the drawer default of 40%, which was measured
 * rather than picked: the More drawer holds a six-cell icon grid that fits in
 * 40%, this holds seven rows of a title and a line of prose, and at 60% the
 * whole "Type it in" group — the fallback for a person holding nothing to
 * upload — sat below the fold. A chooser that hides an option has failed at
 * the one thing it does. At 85% on a 393×852 phone the last row peeks, which
 * is what says the list can be dragged further.
 *
 * Portalling comes from `V3TokenScope`'s `PortalContainerProvider` (V3-22);
 * without it the sheet lands on `<body>` and renders against v2's tokens.
 */

const ICONS: Record<string, LucideIcon> = {
  FileText,
  FileUp,
  Image,
  Keyboard,
  Plug,
  Repeat,
  Wallet,
};

/** ~85% — see the note above. Full height on a drag, like every other v3
 *  drawer, so nothing is ever unreachable. */
const CAPTURE_SNAP_POINTS = [0.85, 1] as const;

const TITLE = 'Add data';
const DESCRIPTION = 'Pick what you have. Everything else follows from that.';

interface CaptureRowProps {
  route: CaptureRoute;
  contextQuery: string;
}

/**
 * `py-3` rather than a tap-target utility: `min-h-tap` is inert on an `<a>`
 * inside v3 (V3-25) and the token layer already supplies 44px under a coarse
 * pointer, so padding is what actually makes the row reachable.
 *
 * `replace`, because the sheet is now a history entry of its own (SC-67) and a
 * push would leave it between the list and the form: Back out of the wallet
 * import would raise the chooser again rather than return to the list.
 * Replacing it also closes the sheet — its `?sheet=` goes with the entry — so
 * there is nothing else for the row to do on the way out.
 */
function CaptureRow({ route, contextQuery }: CaptureRowProps) {
  const Icon = ICONS[route.icon] ?? Keyboard;

  return (
    <li>
      <Link
        to={captureHref(route, contextQuery)}
        replace
        className={cn(
          'flex w-full items-start gap-3 rounded-md px-3 py-3 text-left',
          'transition-colors duration-fast ease-emphasized hover:bg-surface-hover',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
        style={{ transitionDuration: 'var(--motion-fast)' }}
      >
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-1 text-muted-foreground">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-label">{route.title}</span>
          <span className="text-caption text-muted-foreground">{route.description}</span>
        </span>
        <ChevronRight className="mt-2 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </li>
  );
}

/**
 * The list on its own, without either frame. Exported because Radix renders
 * nothing at all under `renderToStaticMarkup`, so this is the half of the
 * sheet a test can assert on.
 */
export function CaptureList({ contextQuery }: { contextQuery: string }) {
  return (
    <div className="flex flex-col gap-4">
      {CAPTURE_GROUPS.map((group) => (
        <section key={group.key} className="flex flex-col gap-1">
          <h3 className="px-3 text-caption font-medium uppercase tracking-wide text-muted-foreground">
            {group.title}
          </h3>
          <ul className="flex flex-col divide-y divide-border">
            {group.routes.map((route) => (
              <CaptureRow key={route.id} route={route} contextQuery={contextQuery} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

interface CaptureSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CaptureSheet({ open, onOpenChange }: CaptureSheetProps) {
  const isDesktop = useIsDesktop();
  const [searchParams] = useSearchParams();
  // Read off the URL the sheet was opened over, so reaching capture from an
  // account's own screen does not make the user pick that account again.
  const contextQuery = captureContextQuery(searchParams);

  if (isDesktop) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="w-full gap-0 overflow-y-auto sm:max-w-md"
          // `SheetContent` sets `backgroundColor` inline against an unset
          // `--background`, and an inline style beats any utility.
          // `--surface-2` is the sheet rung of the ramp (§5.1).
          style={{ backgroundColor: 'hsl(var(--surface-2))' }}
        >
          <SheetHeader className="pr-8 text-left">
            <SheetTitle className="text-title">{TITLE}</SheetTitle>
            <SheetDescription className="text-caption">{DESCRIPTION}</SheetDescription>
          </SheetHeader>
          <div className="pt-4">
            <CaptureList contextQuery={contextQuery} />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <BottomDrawer open={open} onOpenChange={onOpenChange}>
      <BottomDrawerContent
        snapPoints={CAPTURE_SNAP_POINTS}
        expandLabel="Show every way to add data"
        collapseLabel="Show less"
        style={{ backgroundColor: 'hsl(var(--surface-2))' }}
      >
        <BottomDrawerHeader>
          <BottomDrawerTitle>{TITLE}</BottomDrawerTitle>
          <BottomDrawerDescription>{DESCRIPTION}</BottomDrawerDescription>
        </BottomDrawerHeader>
        <BottomDrawerBody>
          <CaptureList contextQuery={contextQuery} />
          {/* The home indicator sits over the last row otherwise. */}
          <div style={{ height: 'env(safe-area-inset-bottom, 0px)' }} />
        </BottomDrawerBody>
      </BottomDrawerContent>
    </BottomDrawer>
  );
}
