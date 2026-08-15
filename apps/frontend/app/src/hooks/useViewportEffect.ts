import { useEffect, useRef } from 'react';

/**
 * Runs `onSettle` whenever the viewport moves, coalesced to one animation
 * frame, and again whenever the app comes back from the background.
 *
 * The second half is the SC-53 finding, and it is measured rather than
 * assumed. On iOS 26.5 a page that is backgrounded and reopened receives
 * `focus` and `visibilitychange` and *nothing else*: across a full
 * background/foreground cycle in the simulator the `visualViewport` listeners
 * were called once before the app went away and not again eleven seconds
 * later when it came back — no `resize`, no `scroll`, no window `resize`.
 * Anything derived from viewport geometry therefore keeps whatever it
 * concluded before the app was suspended, for as long as the page lives.
 * That is exactly the shape of the user's report: a tab bar sitting above a
 * band of dead space that nothing dislodges until the PWA is killed and
 * reopened, because killing it is what forces the geometry to be read again.
 *
 * So a lifecycle event does not schedule a frame, it cancels the one that may
 * be pending and reads the geometry now. A returning page has no frame budget
 * problem to solve — it has a stale conclusion to replace, and waiting for a
 * frame that the platform has no reason to produce is how the stale
 * conclusion survives.
 *
 * `onSettle` is read through a ref so callers can pass an inline closure
 * without re-registering six listeners on every render.
 */
export function useViewportEffect(onSettle: () => void): void {
  const latest = useRef(onSettle);
  latest.current = onSettle;

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    let raf = 0;

    const run = () => {
      raf = 0;
      latest.current();
    };

    const schedule = () => {
      if (raf !== 0) return;
      raf = window.requestAnimationFrame(run);
    };

    const resync = () => {
      if (document.hidden) return;
      if (raf !== 0) window.cancelAnimationFrame(raf);
      run();
    };

    run();

    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    // iOS sometimes fires a late window-level resize after the visual
    // viewport has already settled; listen so we catch that tail event.
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    // The earliest signal that the keyboard is on its way down. iOS does
    // eventually settle the viewport on its own — a browser tab's recovering
    // resize arrived ~360ms after dismissal — but nothing guarantees it, and
    // a missed event is a band that stays.
    window.addEventListener('focusout', schedule);
    window.addEventListener('pageshow', resync);
    document.addEventListener('visibilitychange', resync);

    return () => {
      if (raf !== 0) window.cancelAnimationFrame(raf);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      window.removeEventListener('focusout', schedule);
      window.removeEventListener('pageshow', resync);
      document.removeEventListener('visibilitychange', resync);
    };
  }, []);
}
