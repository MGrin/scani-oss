import { describe, expect, test } from 'bun:test';
import { slidingWindows } from '../../../src/core/utils/time-windows';

const DAY = 24 * 60 * 60 * 1000;

function walk(sinceMs: number, untilMs: number, spanMs: number): Array<[number, number]> {
  return [...slidingWindows(new Date(sinceMs), new Date(untilMs), spanMs)].map(
    (w): [number, number] => [w.start.getTime(), w.end.getTime()]
  );
}

describe('slidingWindows', () => {
  test('splits a range wider than the span, clamping the last window to `until`', () => {
    // 17 days at a 7-day cap: the cap is a venue's limit, so no window may
    // exceed it and the tail must stop at `until` rather than overshoot.
    const windows = walk(0, 17 * DAY, 7 * DAY);
    expect(windows).toEqual([
      [0, 7 * DAY],
      [7 * DAY, 14 * DAY],
      [14 * DAY, 17 * DAY],
    ]);
  });

  test('covers the range with no gap and no overlap', () => {
    const windows = walk(1_000, 1_000 + 95 * DAY, 30 * DAY);
    expect(windows[0]?.[0]).toBe(1_000);
    expect(windows.at(-1)?.[1]).toBe(1_000 + 95 * DAY);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]?.[0]).toBe(windows[i - 1]?.[1] as number);
    }
  });

  test('never yields a window wider than the span', () => {
    for (const [width, span] of [
      [17 * DAY, 7 * DAY],
      [95 * DAY, 30 * DAY],
      [3 * DAY, 30 * DAY],
    ] as const) {
      for (const [start, end] of walk(0, width, span)) {
        expect(end - start).toBeLessThanOrEqual(span);
      }
    }
  });

  test('yields a single window when the range fits inside the span', () => {
    expect(walk(0, 3 * DAY, 30 * DAY)).toEqual([[0, 3 * DAY]]);
  });

  test('yields nothing for an empty or inverted range', () => {
    // A cursor that has already caught up must make zero requests, not one
    // request for a backwards interval that the venue would reject.
    expect(walk(5 * DAY, 5 * DAY, 7 * DAY)).toEqual([]);
    expect(walk(9 * DAY, 5 * DAY, 7 * DAY)).toEqual([]);
  });

  test('refuses a non-positive span instead of looping forever', () => {
    expect(() => walk(0, DAY, 0)).toThrow(/positive/);
    expect(() => walk(0, DAY, -DAY)).toThrow(/positive/);
  });
});
