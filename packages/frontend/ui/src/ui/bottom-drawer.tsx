import * as DrawerPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import * as React from 'react';

import { cn } from '../lib/cn';
import { type PortalContainer, usePortalContainer } from '../lib/portal-container';
import {
  clampDragPosition,
  type DragClaim,
  normalizeSnapPoints,
  resolveDragClaim,
  resolveRelease,
} from '../lib/snap-points';

/**
 * A bottom drawer that rests at one of several heights.
 *
 * `Sheet` is a side panel that happens to accept `side="bottom"`: it is
 * sized by its content and has exactly one state. This has snap points, so
 * a menu can open at a height that shows everything worth showing and grow
 * only if the user asks for more. That is the difference between a drawer
 * you scroll and a drawer you read.
 *
 * Built on Radix Dialog — focus trap, Escape, scroll lock and the portal
 * all come from there. Only the gesture is ours, and its maths lives in
 * `lib/snap-points.ts` where it is testable without a DOM.
 *
 * **The drag surface is the whole sheet** (SC-71 4.1). It was the grab handle
 * alone, on the reasoning that arbitrating with the body's own scroll is easy
 * to get wrong — and the cost of avoiding it was measured: drag-to-dismiss
 * fired 40px into the sheet and failed at 60px, an upward swipe in the body
 * scrolled instead of growing the sheet, and a downward one at `scrollTop 0`
 * did nothing at all. The taller snap point was reachable only by hitting a
 * 36×4px handle. The arbitration itself is two questions, and `resolveDragClaim`
 * answers both; what makes it safe is *when* they are asked — see the
 * `touchmove` note below. The handle is still a button: tapping or pressing
 * Enter on it cycles the snap points, so the taller state is reachable without
 * a pointer at all.
 *
 * The handle is never the only way out. Beside it sits a real close button,
 * because the other two exits both disappear in the state that needs them
 * most: at the tallest snap point the sheet covers the viewport, so there is
 * no overlay left to tap, and a phone has no Escape key. In an installed PWA
 * the handle itself was *also* gone — the sheet's top edge sat under
 * `env(safe-area-inset-top)`, i.e. behind the status bar, invisible and
 * untappable, which left the installed app with an open menu and no way to
 * close it (SC-39). `DRAWER_HEIGHT` below is the fix for that half.
 */

/**
 * How tall the sheet is allowed to be, and therefore where its top edge lands
 * at the tallest snap point.
 *
 * `--scani-banner-offset` is the height of whatever banner is pinned to the
 * top of the page (`useBannerOffset`), and those banners already pad
 * themselves by the safe-area inset — so when one is up it subsumes the
 * inset, and `max()` is what keeps the two from being subtracted twice. When
 * no banner is up the offset is 0 and the raw inset is what matters: in a
 * browser tab that is 0 too, which is why this only ever showed up on an
 * installed PWA.
 */
const DRAWER_HEIGHT =
  'calc(100dvh - max(var(--scani-banner-offset, 0px), env(safe-area-inset-top, 0px)))';

const BottomDrawer = DrawerPrimitive.Root;
const BottomDrawerTrigger = DrawerPrimitive.Trigger;
const BottomDrawerClose = DrawerPrimitive.Close;
const BottomDrawerPortal = DrawerPrimitive.Portal;

const DEFAULT_SNAP_POINTS = [0.4, 1] as const;

const BottomDrawerOverlay = React.forwardRef<
  React.ElementRef<typeof DrawerPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DrawerPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/60 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
));
BottomDrawerOverlay.displayName = DrawerPrimitive.Overlay.displayName;

/** Viewport height the drag is measured against. `visualViewport` is the
 * honest number wherever it exists (it excludes the iOS URL bar);
 * `innerHeight` is the fallback and matches `h-dvh` closely enough. */
function viewportHeight(): number {
  if (typeof window === 'undefined') return 0;
  return window.visualViewport?.height ?? window.innerHeight;
}

/**
 * Travel below this is a tap that wobbled, not a drag. Without it a finger
 * that shifts a pixel on press enters drag mode, resolves back to the snap
 * point it started on, and swallows the tap — so the handle silently stops
 * toggling for anyone whose hand is not perfectly still.
 *
 * It also has a *ceiling*, and that is the load-bearing half now that the
 * whole sheet is draggable: Chrome's touch slop is 8px, so a threshold below
 * it means the claim is decided — and `touchmove` cancelled — before the
 * browser has committed to scrolling anything. Raise this past the slop and a
 * downward drag at `scrollTop 0` starts a native scroll first, which fires
 * `pointercancel` and takes the gesture away mid-flick.
 */
const DRAG_THRESHOLD_PX = 4;

/** Radix's dismissal events are all cancellable; a non-dismissible drawer
 *  cancels them rather than re-implementing the dialog. */
function preventDismissal(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

interface DragState {
  pointerId: number;
  startY: number;
  startPosition: number;
  lastY: number;
  lastTime: number;
  velocity: number;
  /** Who owns the gesture, decided once at `DRAG_THRESHOLD_PX` and never
   *  revisited — a gesture that changes hands mid-flick reads as a fault. */
  claim: DragClaim | null;
  /** Where the list under the finger was scrolled to when the gesture began.
   *  Read at `pointerdown` rather than at the decision, because a native
   *  scroll that slipped through would have moved it by then. */
  scrollTop: number | null;
}

/**
 * How far the list under the finger is scrolled, or `null` when the gesture
 * did not start over one.
 *
 * Walks up to `boundary` (the sheet) rather than to the document: the page
 * behind the drawer is irrelevant to who owns a gesture inside it.
 */
function scrollTopWithin(target: EventTarget | null, boundary: Element): number | null {
  let node = target instanceof Element ? target : null;
  while (node && node !== boundary) {
    if (node.scrollHeight > node.clientHeight) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') return node.scrollTop;
    }
    node = node.parentElement;
  }
  return null;
}

/** Keeps `forwardRef`'s ref working while the component also needs the node —
 *  the `touchmove` listener below cannot be a React prop. */
function assignRef<T>(ref: React.ForwardedRef<T>, node: T | null): void {
  if (typeof ref === 'function') ref(node);
  else if (ref) ref.current = node;
}

export interface BottomDrawerContentProps
  extends React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Content> {
  /** Rest heights as fractions of the viewport, in any order. Normalized to
   * ascending, deduplicated and clamped to `(0, 1]`. */
  snapPoints?: readonly number[];
  /** Which normalized snap point the drawer opens at. Clamped into range. */
  initialSnapIndex?: number;
  /** Accessible name for the handle while the drawer can still grow. */
  expandLabel?: string;
  /** Accessible name for the handle once it is at its tallest. */
  collapseLabel?: string;
  /** Accessible name for the close button. */
  closeLabel?: string;
  /**
   * `false` removes every way out the drawer owns — the close button, Escape,
   * a tap on the overlay and the downward flick — leaving only whatever the
   * caller puts in the body.
   *
   * Reserved for content that cannot be recovered once the drawer is gone,
   * which on a phone is a real hazard rather than a theoretical one: dragging
   * a bottom sheet down is the reflex gesture, and it fires before the reader
   * has decided anything (SC-76). Anything the reader can simply open again
   * stays dismissible.
   */
  dismissible?: boolean;
  /** Where the portal mounts. See `lib/portal-container.tsx`. */
  container?: PortalContainer;
}

const BottomDrawerContent = React.forwardRef<
  React.ElementRef<typeof DrawerPrimitive.Content>,
  BottomDrawerContentProps
>(
  (
    {
      className,
      children,
      style,
      snapPoints = DEFAULT_SNAP_POINTS,
      initialSnapIndex = 0,
      expandLabel = 'Expand',
      collapseLabel = 'Collapse',
      closeLabel = 'Close',
      dismissible = true,
      container,
      ...props
    },
    ref
  ) => {
    const portalContainer = usePortalContainer(container);
    const points = React.useMemo(() => normalizeSnapPoints(snapPoints), [snapPoints]);
    const [index, setIndex] = React.useState(() =>
      Math.min(Math.max(initialSnapIndex, 0), points.length - 1)
    );
    const [dragPosition, setDragPosition] = React.useState<number | null>(null);
    const drag = React.useRef<DragState | null>(null);
    const dragConsumedClick = React.useRef(false);
    const closeRef = React.useRef<HTMLButtonElement>(null);
    const contentRef = React.useRef<HTMLDivElement | null>(null);
    const onTouchMove = React.useRef((event: TouchEvent) => {
      if (drag.current?.claim !== 'sheet') return;
      if (event.cancelable) event.preventDefault();
    }).current;

    const settledIndex = Math.min(index, points.length - 1);
    const position = dragPosition ?? (points[settledIndex] as number);
    // The gesture may sit above 1 (`clampDragPosition` damps rather than
    // blocks, which keeps a wild flick from leaving `position` somewhere
    // absurd for the next drag), but the sheet is exactly `DRAWER_HEIGHT`
    // tall and pinned to the bottom: translating it past 0 would lift its
    // bottom edge off the bottom of the screen and show the page underneath.
    // So overshoot is felt in the release maths and looks like a hard
    // ceiling — one that now stops below the status bar, not under it.
    const rendered = Math.min(position, 1);
    const atCeiling = settledIndex === points.length - 1;

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary) return;
      drag.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startPosition: position,
        lastY: event.clientY,
        lastTime: event.timeStamp,
        velocity: 0,
        claim: null,
        scrollTop: scrollTopWithin(event.target, event.currentTarget),
      };
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      if (state.claim === 'content') return;
      const height = viewportHeight();
      if (height <= 0) return;
      if (state.claim === null) {
        const travel = event.clientY - state.startY;
        if (Math.abs(travel) < DRAG_THRESHOLD_PX) return;
        state.claim = resolveDragClaim({
          deltaY: travel,
          scrollTop: state.scrollTop,
          atCeiling,
        });
        if (state.claim === 'content') return;
        // Only once the sheet has the gesture: capturing a pointer the body is
        // about to scroll with would be claiming it by another name.
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      const elapsed = event.timeStamp - state.lastTime;
      // A zero-length frame would divide by zero; keeping the previous
      // velocity is closer to the truth than pretending the finger stopped.
      if (elapsed > 0) {
        state.velocity = (state.lastY - event.clientY) / height / elapsed;
        state.lastY = event.clientY;
        state.lastTime = event.timeStamp;
      }
      setDragPosition(
        clampDragPosition(state.startPosition - (event.clientY - state.startY) / height, points)
      );
    };

    const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      drag.current = null;
      if (!state || state.pointerId !== event.pointerId || dragPosition === null) return;
      const outcome = resolveRelease(dragPosition, state.velocity, points, { dismissible });
      setDragPosition(null);
      if (outcome.close) {
        // Not flagged as drag-consumed: the dismissal *is* a programmatic click
        // on the Close below, and it bubbles through the same capture handler
        // that swallows the click a drag would otherwise leave behind.
        closeRef.current?.click();
        return;
      }
      // A press with no movement is a tap; leave it to the click handler so
      // pointer and keyboard take the same path. A press that moved the sheet
      // is not a tap on whatever the finger came to rest over.
      dragConsumedClick.current = true;
      setIndex(outcome.index);
    };

    const handlePointerCancel = () => {
      drag.current = null;
      setDragPosition(null);
    };

    const handleClick = () => setIndex(atCeiling ? 0 : settledIndex + 1);

    // A drag that ends over a link must not open it. Capture rather than
    // bubble, so the swallow happens before the row's own handler runs.
    const handleClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
      if (!dragConsumedClick.current) return;
      dragConsumedClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    };

    /**
     * The one listener React cannot express. `onTouchMove` is registered
     * passively by React 18+, and a passive listener may not `preventDefault` —
     * which is the only thing that stops the browser scrolling the body with a
     * gesture the sheet has claimed. It runs *after* `pointermove` for the same
     * input, so the claim is already decided by the time it fires; all this
     * does is act on it.
     */
    const attachContent = React.useCallback(
      (node: HTMLDivElement | null) => {
        assignRef(ref, node);
        contentRef.current?.removeEventListener('touchmove', onTouchMove);
        contentRef.current = node;
        node?.addEventListener('touchmove', onTouchMove, { passive: false });
      },
      // `onTouchMove` is held in a ref, so it never changes identity and the
      // node is attached exactly once per mount. It is listed anyway: a
      // dependency array that lies is worse than one with a stable entry in it.
      [ref, onTouchMove]
    );

    return (
      <BottomDrawerPortal container={portalContainer}>
        <BottomDrawerOverlay />
        <DrawerPrimitive.Content
          ref={attachContent}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onClickCapture={handleClickCapture}
          // Radix closes on Escape and on a press outside the content, and
          // that is right for every drawer but the ones the caller has marked
          // `dismissible={false}`. Both are cheap reflexes — Escape closes
          // every other sheet in the app — so the opt-out has to reach them
          // and not just the visible controls.
          onEscapeKeyDown={dismissible ? undefined : preventDismissal}
          onInteractOutside={dismissible ? undefined : preventDismissal}
          // Radix autofocuses the first focusable child on open, and here that
          // is the grab handle — so every drawer in the app opened with a
          // full-width focus ring drawn around its handle, on a control the
          // user never reached for. Focusing the content itself instead is
          // what a dialog is supposed to do: the reading position moves into
          // the sheet and the focus trap still holds, but nothing is painted
          // as though it were the active control. Radix gives Content
          // `tabIndex={-1}`, so it is a legal focus target.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
          className={cn(
            // `focus:outline-none` on the container only. It is focused
            // programmatically to move the reading position into the sheet,
            // never reached by Tab, so an outline here marks nothing the user
            // did — and because the content is a full viewport tall and
            // translated, the browser painted it as a bar across the drawer's
            // top edge. Every real control inside keeps its own
            // `focus-visible` ring.
            'fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-lg border-t border-border bg-popover text-popover-foreground focus:outline-none',
            className
          )}
          style={{
            // Inline rather than a class so a caller's `className` cannot
            // silently reintroduce the full-viewport height this exists to
            // avoid. A caller that genuinely needs a different ceiling passes
            // `style.height`, which still wins via the spread below.
            height: DRAWER_HEIGHT,
            transform: `translate3d(0, ${(1 - rendered) * 100}%, 0)`,
            // No transition while a finger is down: the drawer has to track
            // the pointer exactly, and easing a value that already follows
            // the finger is what makes a drag feel like it is lagging.
            transition:
              dragPosition === null
                ? 'transform var(--motion-base, 180ms) var(--motion-ease, ease)'
                : 'none',
            willChange: 'transform',
            // A drag now starts over real content, and a mouse drag over text
            // selects it — a sheet that highlights half its own body while it
            // moves reads as a broken page rather than a gesture.
            userSelect: dragPosition === null ? undefined : 'none',
            // Same reasoning as `Sheet`'s inline fallback: `bg-popover`
            // resolves through a portal only if `--popover` is in scope
            // there, and an unset var makes `hsl()` invalid, i.e.
            // transparent. The literal is the v3 dark sheet surface.
            backgroundColor: 'hsl(var(--popover, 225 12% 16%))',
            ...style,
          }}
          {...props}
        >
          {/* The sheet is `DRAWER_HEIGHT` tall so the drag is a transform and
              nothing reflows, but only the top `rendered` of it is on screen.
              Bounding the flex column to that fraction is what makes
              `BottomDrawerBody`'s `flex-1` mean "the visible remainder": let
              the column run the whole viewport instead and the body's
              scrollHeight never exceeds its clientHeight, so it never
              scrolls, and everything past the fold is simply unreachable. */}
          <div className="flex flex-col" style={{ height: `${rendered * 100}%` }}>
            <div className="relative flex shrink-0 items-center">
              {/* First in the DOM so it is the first Tab stop and the first
                  thing VoiceOver reaches after focus lands on the sheet: the
                  way out should not be behind the way to make it bigger.
                  Positioned rather than laid out so the handle stays centred
                  on the sheet, not on the space left over beside this.

                  It is also what the drag calls when a flick resolves to a
                  dismiss — Radix's own Close is the only thing that knows how
                  to close a drawer whether it is controlled or not, so the
                  gesture clicks it rather than reaching for state it cannot
                  see.

                  Absent entirely when the drawer is not dismissible: a × that
                  is rendered and does nothing is worse than no ×, because the
                  reader presses it and concludes the app is broken. */}
              {dismissible ? (
                <DrawerPrimitive.Close
                  ref={closeRef}
                  aria-label={closeLabel}
                  className="absolute right-2 z-10 inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{
                    minHeight: 'var(--tap-target, 2.75rem)',
                    minWidth: 'var(--tap-target, 2.75rem)',
                  }}
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </DrawerPrimitive.Close>
              ) : null}
              <button
                type="button"
                aria-label={atCeiling ? collapseLabel : expandLabel}
                aria-expanded={atCeiling}
                // The gesture belongs to the content element now; this only
                // has to stay a real button so a tap and Enter both cycle the
                // snap points. `touch-none` remains, so a drag that starts
                // here can never be read as a scroll of anything.
                onClick={handleClick}
                className="flex w-full shrink-0 cursor-grab touch-none items-center justify-center py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:cursor-grabbing"
                style={{ minHeight: 'var(--tap-target, 2.75rem)' }}
              >
                <span aria-hidden="true" className="h-1 w-9 rounded-full bg-border" />
              </button>
            </div>
            {children}
          </div>
        </DrawerPrimitive.Content>
      </BottomDrawerPortal>
    );
  }
);
BottomDrawerContent.displayName = DrawerPrimitive.Content.displayName;

const BottomDrawerHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('shrink-0 px-4 pb-3', className)} {...props} />
);
BottomDrawerHeader.displayName = 'BottomDrawerHeader';

/** The scrolling region. `overscroll-contain` stops a flick at the end of
 * this list from scrolling the page behind the drawer. */
const BottomDrawerBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-4', className)}
    {...props}
  />
);
BottomDrawerBody.displayName = 'BottomDrawerBody';

const BottomDrawerTitle = React.forwardRef<
  React.ElementRef<typeof DrawerPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DrawerPrimitive.Title
    ref={ref}
    className={cn('text-title text-foreground', className)}
    {...props}
  />
));
BottomDrawerTitle.displayName = DrawerPrimitive.Title.displayName;

const BottomDrawerDescription = React.forwardRef<
  React.ElementRef<typeof DrawerPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DrawerPrimitive.Description
    ref={ref}
    className={cn('text-caption text-muted-foreground', className)}
    {...props}
  />
));
BottomDrawerDescription.displayName = DrawerPrimitive.Description.displayName;

export {
  BottomDrawer,
  BottomDrawerBody,
  BottomDrawerClose,
  BottomDrawerContent,
  BottomDrawerDescription,
  BottomDrawerHeader,
  BottomDrawerOverlay,
  BottomDrawerPortal,
  BottomDrawerTitle,
  BottomDrawerTrigger,
};
