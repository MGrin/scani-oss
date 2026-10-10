import '../../i18n-preload';
import { describe, expect, test } from 'bun:test';
import {
  CHROME_AT_REST,
  type ChromeScrollState,
  HIDE_AFTER_PX,
  nextChromeScroll,
} from '../../../src/v3/lib/scroll-chrome';

const MAX_Y = 2000;

function scrollThrough(ys: number[], from: ChromeScrollState = CHROME_AT_REST): ChromeScrollState {
  return ys.reduce((state, y) => nextChromeScroll(state, { y, maxY: MAX_Y }), from);
}

const steps = (from: number, to: number, by: number) => {
  const out: number[] = [];
  for (let y = from; by > 0 ? y <= to : y >= to; y += by) out.push(y);
  return out;
};

describe('the v3 chrome hides on scroll down and returns on scroll up (SC-1631)', () => {
  test('stays shown until the page has travelled down past the threshold', () => {
    expect(scrollThrough(steps(0, HIDE_AFTER_PX - 8, 8)).hidden).toBe(false);
    expect(scrollThrough(steps(0, HIDE_AFTER_PX + 8, 8)).hidden).toBe(true);
  });

  test('any scroll up brings it back', () => {
    const hidden = scrollThrough(steps(0, 600, 20));
    expect(hidden.hidden).toBe(true);
    expect(scrollThrough([596], hidden).hidden).toBe(false);
  });

  test('sub-pixel jitter while scrolling down does not flicker it back', () => {
    const hidden = scrollThrough(steps(0, 600, 20));
    expect(scrollThrough([599, 620, 619.5, 640], hidden).hidden).toBe(true);
  });

  test('a downward run starts again after a scroll up', () => {
    const shown = scrollThrough([...steps(0, 600, 20), 580]);
    expect(shown.hidden).toBe(false);
    expect(scrollThrough([590, 600], shown).hidden).toBe(false);
    expect(scrollThrough(steps(590, 580 + HIDE_AFTER_PX + 20, 10), shown).hidden).toBe(true);
  });

  test('reaching the top brings it back', () => {
    const hidden = scrollThrough(steps(0, 600, 20));
    expect(scrollThrough([0], hidden).hidden).toBe(false);
  });

  test('the iOS rubber-band above the top never hides it', () => {
    expect(scrollThrough([-40, -80, -20, 0, -10]).hidden).toBe(false);
  });

  test('the rubber-band past the bottom does not read as a scroll up', () => {
    const atBottom = scrollThrough(steps(1000, MAX_Y, 50));
    expect(atBottom.hidden).toBe(true);
    expect(scrollThrough([MAX_Y + 60, MAX_Y + 30, MAX_Y], atBottom).hidden).toBe(true);
  });

  // Hiding the tab bar shrinks the spacer that reserves its room, and at the
  // end of the page the browser clamps the offset down with it. That is not
  // the reader scrolling up, and reading it as one would bring the bar back
  // and grow the spacer again, on a loop (SC-1631).
  test('the end of the page clamping in as the spacer shrinks does not bring it back', () => {
    const atEnd = scrollThrough(steps(1000, MAX_Y, 50));
    const clamped = [MAX_Y - 10, MAX_Y - 30, MAX_Y - 56].reduce(
      (state, y) => nextChromeScroll(state, { y, maxY: y }),
      atEnd
    );
    expect(clamped.hidden).toBe(true);
    expect(nextChromeScroll(clamped, { y: MAX_Y - 56 - 20, maxY: MAX_Y - 56 }).hidden).toBe(false);
  });

  test('a long downward run that starts at the top hides only once the bar has scrolled by', () => {
    expect(scrollThrough([HIDE_AFTER_PX - 1]).hidden).toBe(false);
  });
});
