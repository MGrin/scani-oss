import { describe, expect, test } from 'bun:test';
import {
  clampDragPosition,
  nearestSnapIndex,
  normalizeSnapPoints,
  resolveDragClaim,
  resolveRelease,
} from '../../src/lib/snap-points';

const TWO_STOP = [0.4, 1];

describe('normalizeSnapPoints', () => {
  test('sorts, deduplicates and drops out-of-range values', () => {
    expect(normalizeSnapPoints([1, 0.4, 0.4, 0, -0.2, 1.5, Number.NaN])).toEqual([0.4, 1]);
  });

  test('throws when nothing survives, rather than inventing a rest state', () => {
    expect(() => normalizeSnapPoints([0, 2])).toThrow(/at least one value/);
  });
});

describe('clampDragPosition', () => {
  test('leaves positions inside the range untouched', () => {
    expect(clampDragPosition(0.62, TWO_STOP)).toBe(0.62);
  });

  test('damps overshoot above the tallest snap point instead of blocking it', () => {
    const overshot = clampDragPosition(1.5, TWO_STOP);
    expect(overshot).toBeGreaterThan(1);
    expect(overshot).toBeLessThan(1.15);
  });

  test('tracks a downward drag one-to-one, so a dismissal follows the finger', () => {
    expect(clampDragPosition(0.1, TWO_STOP)).toBe(0.1);
  });

  test('never reports a negative height', () => {
    expect(clampDragPosition(-0.3, TWO_STOP)).toBe(0);
  });
});

describe('nearestSnapIndex', () => {
  test('picks the closer stop', () => {
    expect(nearestSnapIndex(0.45, TWO_STOP)).toBe(0);
    expect(nearestSnapIndex(0.9, TWO_STOP)).toBe(1);
  });

  test('breaks an exact tie toward the taller stop', () => {
    expect(nearestSnapIndex(0.7, TWO_STOP)).toBe(1);
  });
});

describe('resolveRelease', () => {
  test('a still release settles on the nearest stop', () => {
    expect(resolveRelease(0.44, 0, TWO_STOP)).toEqual({ close: false, index: 0 });
    expect(resolveRelease(0.85, 0, TWO_STOP)).toEqual({ close: false, index: 1 });
  });

  test('an upward flick clears a stop it had not reached', () => {
    // 0.45 is nearest to 0.4, but travelling up fast enough to project past
    // the midpoint. Snapping back here is what reads as a refused gesture.
    expect(resolveRelease(0.45, 0.003, TWO_STOP)).toEqual({ close: false, index: 1 });
  });

  test('a downward flick from full height lands on the lower stop, not closed', () => {
    expect(resolveRelease(0.95, -0.003, TWO_STOP)).toEqual({ close: false, index: 0 });
  });

  test('dragging well below the smallest stop closes', () => {
    expect(resolveRelease(0.15, 0, TWO_STOP).close).toBe(true);
  });

  test('a small undershoot springs back rather than dismissing', () => {
    expect(resolveRelease(0.3, 0, TWO_STOP)).toEqual({ close: false, index: 0 });
  });

  test('a hard downward flick from the rest state closes even before the threshold', () => {
    expect(resolveRelease(0.38, -0.002, TWO_STOP).close).toBe(true);
  });

  test('a single snap point still resolves', () => {
    expect(resolveRelease(0.9, 0, [1])).toEqual({ close: false, index: 0 });
    expect(resolveRelease(0.4, 0, [1]).close).toBe(true);
  });

  describe('dismissible: false', () => {
    // A drawer showing something the reader cannot get back: the flick is
    // still felt (the sheet moves and springs), but it settles instead of
    // dismissing. On a phone this is the exit that fires first, before the
    // reader has decided anything (SC-76).
    test('a drag well below the smallest stop settles instead of closing', () => {
      expect(resolveRelease(0.15, 0, TWO_STOP, { dismissible: false })).toEqual({
        close: false,
        index: 0,
      });
    });

    test('a hard downward flick settles instead of closing', () => {
      expect(resolveRelease(0.38, -0.002, TWO_STOP, { dismissible: false })).toEqual({
        close: false,
        index: 0,
      });
    });

    test('the snap points a release does not close on are unchanged', () => {
      expect(resolveRelease(0.44, 0, TWO_STOP, { dismissible: false })).toEqual({
        close: false,
        index: 0,
      });
      expect(resolveRelease(0.85, 0, TWO_STOP, { dismissible: false })).toEqual({
        close: false,
        index: 1,
      });
    });

    test('omitting the option leaves every drawer dismissible', () => {
      expect(resolveRelease(0.15, 0, TWO_STOP, {}).close).toBe(true);
      expect(resolveRelease(0.15, 0, TWO_STOP, { dismissible: true }).close).toBe(true);
    });
  });
});

/**
 * The arbitration that made the whole sheet draggable (SC-71 4.1). Each case
 * below is a gesture QA mapped by hand and found dead: the drag hit-strip was
 * ~50px at the top of the sheet, and the taller snap point was reachable only
 * by grabbing a 36×4px handle.
 */
describe('resolveDragClaim', () => {
  test('a downward drag over a list already at its top moves the sheet', () => {
    expect(resolveDragClaim({ deltaY: 20, scrollTop: 0, atCeiling: false })).toBe('sheet');
    expect(resolveDragClaim({ deltaY: 20, scrollTop: 0, atCeiling: true })).toBe('sheet');
  });

  test('a downward drag over a scrolled list scrolls it back', () => {
    // The one case the handle-only rule got right, and the reason arbitration
    // is needed at all: dismissing here would eat a scroll the user meant.
    expect(resolveDragClaim({ deltaY: 20, scrollTop: 140, atCeiling: true })).toBe('content');
  });

  test('a downward drag over nothing scrollable moves the sheet', () => {
    // The header, the handle, a short body: no scroller between the finger and
    // the sheet, so there is nothing the gesture could belong to instead.
    expect(resolveDragClaim({ deltaY: 20, scrollTop: null, atCeiling: false })).toBe('sheet');
  });

  test('an upward drag grows the sheet before it scrolls the body', () => {
    // The second snap point, reachable with the same flick that reveals what
    // it holds. Scrolling here is what made it unreachable.
    expect(resolveDragClaim({ deltaY: -20, scrollTop: 0, atCeiling: false })).toBe('sheet');
    expect(resolveDragClaim({ deltaY: -20, scrollTop: 300, atCeiling: false })).toBe('sheet');
  });

  test('an upward drag at full height scrolls the body', () => {
    // There is no taller state to grow into, so the gesture is the list's.
    expect(resolveDragClaim({ deltaY: -20, scrollTop: 0, atCeiling: true })).toBe('content');
  });

  test('no vertical travel claims nothing', () => {
    expect(resolveDragClaim({ deltaY: 0, scrollTop: 0, atCeiling: false })).toBe('content');
  });

  test('a negative scrollTop counts as the top', () => {
    // iOS reports a rubber-banded overscroll as a negative scrollTop; treating
    // it as "scrolled" would kill the drag exactly when the finger is already
    // past the end of the list.
    expect(resolveDragClaim({ deltaY: 20, scrollTop: -12, atCeiling: true })).toBe('sheet');
  });
});
