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

  // SC-1714. The page keeps the tab bar's room at its end whether the bars are
  // shown or not, since resizing anything mid-scroll moved the page under the
  // finger. So the bars come back at the end and cover that room, rather than
  // leaving it as a band under the last card.
  test('reaching the end of the page brings it back', () => {
    const hidden = scrollThrough(steps(1000, MAX_Y - 100, 50));
    expect(hidden.hidden).toBe(true);
    expect(scrollThrough([MAX_Y], hidden).hidden).toBe(false);
  });

  test('the rubber-band past the bottom keeps it shown', () => {
    const atEnd = scrollThrough(steps(1000, MAX_Y, 50));
    expect(scrollThrough([MAX_Y + 60, MAX_Y + 30, MAX_Y], atEnd).hidden).toBe(false);
  });

  test('a long downward run that starts at the top hides only once the bar has scrolled by', () => {
    expect(scrollThrough([HIDE_AFTER_PX - 1]).hidden).toBe(false);
  });
});
