import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { CHROME_AT_REST, type ChromeScrollState, nextChromeScroll } from '../lib/scroll-chrome';

/** Below `lg`, where the header and the tab bar exist. */
const PHONE = '(max-width: 1023.98px)';
/**
 * Reduced motion keeps both bars still rather than snapping them away: chrome
 * that vanishes and reappears under a scrolling finger is itself the motion
 * that setting asks us not to make, with or without the slide.
 */
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/**
 * Whether the phone shell's header and tab bar are slid out of the way
 * (SC-1631). The scroller is `<main>`, not the window. They come back on any
 * scroll up, at the top, when `resetKey` changes (a route or a `?sheet=`),
 * when the visual viewport resizes (the keyboard closing), and through
 * `reveal` (focus entering a bar). `suspended` holds them out during a pull to
 * refresh, which is a gesture at the top and must not move them.
 */
export function useHideChromeOnScroll(
  scrollerRef: RefObject<HTMLElement | null>,
  { suspended, resetKey }: { suspended: boolean; resetKey: string }
): { hidden: boolean; reveal: () => void } {
  const phone = useMedia(PHONE);
  const reducedMotion = useMedia(REDUCED_MOTION);
  const enabled = phone && !reducedMotion && !suspended;
  const [hidden, setHidden] = useState(false);
  const state = useRef<ChromeScrollState>(CHROME_AT_REST);

  const reveal = useCallback(() => {
    state.current = { ...CHROME_AT_REST, lastY: scrollerRef.current?.scrollTop ?? 0 };
    setHidden(false);
  }, [scrollerRef]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!enabled || !scroller) {
      reveal();
      return;
    }
    reveal();
    const onScroll = () => {
      state.current = nextChromeScroll(state.current, {
        y: scroller.scrollTop,
        maxY: scroller.scrollHeight - scroller.clientHeight,
      });
      setHidden(state.current.hidden);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.visualViewport?.addEventListener('resize', reveal);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      window.visualViewport?.removeEventListener('resize', reveal);
    };
  }, [enabled, reveal, scrollerRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the trigger; reveal reads no state from it
  useEffect(() => {
    reveal();
  }, [resetKey, reveal]);

  return { hidden: enabled && hidden, reveal };
}
