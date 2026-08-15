import { canArmPullToRefresh } from '@scani/ui/lib/pull-to-refresh';
import { type RefObject, useEffect, useRef, useState } from 'react';

/**
 * Pull-to-refresh for the v3 shell's page scroller (V3-34).
 *
 * Not the shared `PullToRefresh` component, and deliberately so: that one
 * *creates* the scroll container it refreshes and translates its children
 * down. v3's scroller already exists — it is the `<main>` that carries
 * `view-transition-name` (V3-16) and the tab-bar spacer — so wrapping it
 * would nest a second scroller inside the first and put the pulled content
 * inside the route-transition snapshot. What the two share is the part that
 * was actually wrong: `canArmPullToRefresh`, in `@scani/ui`.
 *
 * The content does not move. Only the indicator descends, the way iOS does
 * it: moving the page means the list the user is reading jumps, and in a
 * region with a `view-transition-name` it means fighting the compositor.
 *
 * There is no PWA gate here, unlike the v2 component. That gate exists so the
 * gesture never fights the browser's own pull, and in this shell there is
 * nothing to fight: the v3 root is `h-dvh overflow-hidden`, so the document
 * never scrolls, and the scroller sets `overscroll-behavior-y: contain`.
 * Gating on standalone mode would leave everyone who has not installed the
 * app — which is most people on a phone — with no way to refresh at all.
 */

export type PullPhase = 'idle' | 'pulling' | 'ready' | 'refreshing';

export interface PullToRefreshState {
  phase: PullPhase;
  /** Pixels the indicator has travelled down from the top of the scroller. */
  distance: number;
  /** `distance` as a 0–1 fraction of the trigger, for the indicator's dial. */
  progress: number;
}

/** Finger travel before a touch counts as a pull rather than a tap or a scroll. */
const ENGAGE_DISTANCE = 12;
/** Travel past which releasing refreshes. */
const TRIGGER_DISTANCE = 72;
/** Where the indicator stops following the finger. */
const MAX_DISTANCE = 96;
/** The indicator moves half as far as the finger, so the pull has weight. */
const RESISTANCE = 0.5;
/**
 * A refetch that lands in 60ms would blink the indicator out before the eye
 * finds it, and the user would not know whether anything happened. This is
 * the floor on how long "refreshing" is shown — not a delay on the data,
 * which renders the moment it arrives.
 */
const MIN_VISIBLE_REFRESH_MS = 450;
/**
 * And the ceiling. While the indicator is up the page is held 72px down, so a
 * refetch that takes its time takes the top of the screen with it — measured
 * at 16s locally against a contended database. Past this the gesture hands the
 * page back and the refetch carries on in the background; nothing is
 * cancelled, and each list already renders its own loading and error state
 * (§2.5), so the wait is reported where the data is rather than by pinning
 * the whole screen.
 */
const MAX_VISIBLE_REFRESH_MS = 4000;

export function usePullToRefresh(
  scrollerRef: RefObject<HTMLElement | null>,
  onRefresh: () => Promise<unknown>
): PullToRefreshState {
  const [phase, setPhase] = useState<PullPhase>('idle');
  const [distance, setDistance] = useState(0);

  // Read through a ref so a new `onRefresh` identity does not tear down and
  // re-register the listeners mid-gesture.
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    let armed = false;
    let refreshing = false;
    let cancelled = false;
    let startX = 0;
    let startY = 0;
    let travelled = 0;
    let frame: number | null = null;

    // Touch moves arrive faster than React can render; coalescing to one
    // frame keeps the indicator on the finger instead of behind it.
    const draw = (next: number) => {
      travelled = next;
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!cancelled) setDistance(travelled);
      });
    };

    /** Put the indicator away, without ending the gesture. */
    const rest = () => {
      draw(0);
      if (!cancelled) setPhase('idle');
    };

    /** Put the indicator away and give up on this gesture entirely. */
    const abandon = () => {
      armed = false;
      rest();
    };

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      armed =
        !refreshing &&
        !!touch &&
        event.touches.length === 1 &&
        // At rest at the very top. `> 0`, not `> 1`: momentum from a flick
        // that has not fully stopped is not a pull.
        scroller.scrollTop === 0 &&
        canArmPullToRefresh(event.target as Element | null, scroller).armed;

      if (armed && touch) {
        startX = touch.clientX;
        startY = touch.clientY;
      }
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!armed || refreshing) return;

      const touch = event.touches[0];
      if (!touch || event.touches.length !== 1) {
        abandon();
        return;
      }

      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;

      // Horizontal intent, e.g. the allocation bar. Once the axis is lost it
      // stays lost for the rest of the gesture — a diagonal drag that drifts
      // back downward must not resume pulling.
      if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > ENGAGE_DISTANCE) {
        abandon();
        return;
      }

      // The scroller moved under us — the pull became a scroll.
      if (scroller.scrollTop > 0) {
        abandon();
        return;
      }

      if (deltaY <= ENGAGE_DISTANCE) {
        // Pulled back up past the engage point without lifting: the
        // indicator goes away, but the finger is still down and still at the
        // top, so pulling again is allowed.
        if (travelled !== 0) rest();
        return;
      }

      // Owning the gesture. Without this the scroller rubber-bands behind the
      // indicator and the two disagree about where the finger is; it is why
      // the move listener has to be non-passive.
      event.preventDefault();

      const next = Math.min((deltaY - ENGAGE_DISTANCE) * RESISTANCE, MAX_DISTANCE);
      draw(next);
      if (!cancelled) setPhase(next >= TRIGGER_DISTANCE ? 'ready' : 'pulling');
    };

    const handleTouchEnd = () => {
      if (!armed) return;
      armed = false;

      if (travelled < TRIGGER_DISTANCE) {
        rest();
        return;
      }

      refreshing = true;
      draw(TRIGGER_DISTANCE);
      if (!cancelled) setPhase('refreshing');

      void (async () => {
        // Nothing to report on failure that the page is not already
        // reporting: every v3 list renders its own query's error state, so a
        // failed refetch shows up where the data would have been.
        const done = refresh.current().catch(() => {});
        const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        await Promise.all([
          Promise.race([done, after(MAX_VISIBLE_REFRESH_MS)]),
          after(MIN_VISIBLE_REFRESH_MS),
        ]);
        refreshing = false;
        rest();
      })();
    };

    scroller.addEventListener('touchstart', handleTouchStart, { passive: true });
    scroller.addEventListener('touchmove', handleTouchMove, { passive: false });
    scroller.addEventListener('touchend', handleTouchEnd, { passive: true });
    scroller.addEventListener('touchcancel', handleTouchEnd, { passive: true });

    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
      scroller.removeEventListener('touchstart', handleTouchStart);
      scroller.removeEventListener('touchmove', handleTouchMove);
      scroller.removeEventListener('touchend', handleTouchEnd);
      scroller.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [scrollerRef]);

  return { phase, distance, progress: Math.min(distance / TRIGGER_DISTANCE, 1) };
}
