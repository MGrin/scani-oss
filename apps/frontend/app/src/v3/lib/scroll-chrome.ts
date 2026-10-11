/**
 * Whether the phone shell's header and tab bar are out of the way, from the
 * scroller's offsets (SC-1631). Pure, so the decision is testable apart from
 * the DOM that feeds it.
 *
 * Down hides only after `HIDE_AFTER_PX` of uninterrupted travel, so a small
 * nudge never moves the chrome. Any scroll up past `UP_JITTER_PX` brings it
 * back: wanting the bar back is the reason people scroll up. `y` is clamped
 * to `[0, maxY]`, because iOS reports the rubber-band as offsets beyond
 * either end, and its bounce back would otherwise read as a scroll up. A move
 * back that lands on the bottom edge is the page end clamping in as the tab
 * bar's spacer shrinks, not the reader: counting it would bring the bar back
 * and grow the spacer again, on a loop.
 */
export interface ChromeScrollState {
  hidden: boolean;
  lastY: number;
  downRun: number;
}

export const HIDE_AFTER_PX = 48;
const UP_JITTER_PX = 2;

export const CHROME_AT_REST: ChromeScrollState = { hidden: false, lastY: 0, downRun: 0 };

export function nextChromeScroll(
  prev: ChromeScrollState,
  { y, maxY }: { y: number; maxY: number }
): ChromeScrollState {
  const at = Math.min(Math.max(y, 0), Math.max(maxY, 0));
  if (at <= 0) return CHROME_AT_REST;

  const delta = at - prev.lastY;
  if (delta < 0 && at >= maxY - 1) return { ...prev, lastY: at };
  if (delta < -UP_JITTER_PX) return { hidden: false, lastY: at, downRun: 0 };
  if (delta <= 0) return { ...prev, lastY: at };

  const downRun = prev.downRun + delta;
  return {
    hidden: prev.hidden || (downRun >= HIDE_AFTER_PX && at >= HIDE_AFTER_PX),
    lastY: at,
    downRun,
  };
}
