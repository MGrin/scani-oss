import { describe, expect, test } from 'bun:test';
import {
  CHART_OTHER_COLOR,
  CHART_SERIES_LIMIT,
  CHART_SLOT_COUNT,
  chartSlotColor,
  foldAllocation,
} from '@scani/ui/v3/lib/chart';

const item = (key: string, value: number) => ({ key, label: key, value });

describe('chartSlotColor', () => {
  test('returns a custom-property reference, not a resolved colour', () => {
    // The theme-stability mechanism. A resolved hex would be read once, at
    // mount, against whichever theme happened to be live.
    expect(chartSlotColor(1)).toBe('hsl(var(--chart-1))');
    expect(chartSlotColor(CHART_SLOT_COUNT)).toBe('hsl(var(--chart-8))');
  });

  test('refuses a slot outside the ramp rather than cycling', () => {
    // Cycling is what makes a ninth series impersonate the first.
    expect(() => chartSlotColor(0)).toThrow(RangeError);
    expect(() => chartSlotColor(CHART_SLOT_COUNT + 1)).toThrow(RangeError);
    expect(() => chartSlotColor(1.5)).toThrow(RangeError);
  });
});

describe('foldAllocation — shares', () => {
  test('shares are fractions of the total and always sum to 1', () => {
    const segments = foldAllocation([item('a', 75), item('b', 25)]);
    expect(segments.map((s) => s.share)).toEqual([0.75, 0.25]);
    expect(segments.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 10);
  });

  test('a bar with nothing in it is nothing, not a zero-width bar', () => {
    expect(foldAllocation([])).toEqual([]);
    expect(foldAllocation([item('a', 0)])).toEqual([]);
  });

  test('non-positive and non-finite parts are dropped, not drawn', () => {
    // A share-of-total bar cannot draw a negative part, and NaN would poison
    // every other share through the total.
    const segments = foldAllocation([
      item('a', 60),
      item('b', -10),
      item('c', Number.NaN),
      item('d', 40),
    ]);
    expect(segments.map((s) => s.key)).toEqual(['a', 'd']);
    expect(segments.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 10);
  });
});

describe('foldAllocation — colour follows the entity', () => {
  test('slot assignment follows input order, not size', () => {
    // The data-viz non-negotiable: colour encodes which series this is, never
    // its rank. Ordering by current value would repaint the whole bar the next
    // time prices moved.
    const segments = foldAllocation([item('small', 1), item('big', 99)]);
    expect(segments.map((s) => s.color)).toEqual(['hsl(var(--chart-1))', 'hsl(var(--chart-2))']);
  });

  test("a sibling's value changing does not repaint the survivors", () => {
    const before = foldAllocation([item('a', 10), item('b', 90)]);
    const after = foldAllocation([item('a', 90), item('b', 10)]);
    expect(after.map((s) => s.color)).toEqual(before.map((s) => s.color));
  });

  test('slots are contiguous from 1, so only validated pairs sit adjacent', () => {
    // The palette's colourblind separation was validated on adjacent pairs of
    // the ramp in order. A bar spending slots 1, 2 and 4 would put an untested
    // pair side by side.
    const segments = foldAllocation([1, 2, 3, 4].map((n) => item(`k${n}`, 25)));
    expect(segments.map((s) => s.color)).toEqual([1, 2, 3, 4].map((n) => `hsl(var(--chart-${n}))`));
  });
});

describe('foldAllocation — the fold', () => {
  test('spends at most six slots before folding', () => {
    const segments = foldAllocation(Array.from({ length: 12 }, (_, i) => item(`k${i}`, 10)));
    expect(segments).toHaveLength(CHART_SERIES_LIMIT);
    expect(segments[CHART_SERIES_LIMIT - 1]?.key).toBe('__other__');
    expect(segments[CHART_SERIES_LIMIT - 1]?.color).toBe(CHART_OTHER_COLOR);
    // Slots 7 and 8 are `--interactive`'s and `--loss`'s hues; nothing may
    // reach them.
    expect(segments.map((s) => s.color)).not.toContain('hsl(var(--chart-7))');
  });

  test('the fold carries the summed value and how many parts it stands for', () => {
    const segments = foldAllocation(Array.from({ length: 8 }, (_, i) => item(`k${i}`, 10)));
    const other = segments[segments.length - 1];
    expect(other?.key).toBe('__other__');
    expect(other?.value).toBe(30);
    expect(other?.sources).toBe(3);
    expect(other?.share).toBeCloseTo(30 / 80, 10);
  });

  test('exactly six parts fill the budget without folding', () => {
    const segments = foldAllocation(Array.from({ length: 6 }, (_, i) => item(`k${i}`, 10)));
    expect(segments).toHaveLength(6);
    expect(segments.map((s) => s.key)).not.toContain('__other__');
    expect(segments.every((s) => s.sources === 1)).toBe(true);
  });

  test('a budget-triggered fold always stands for at least two parts', () => {
    // One slot is held back as soon as the parts outnumber the budget, so
    // "Other" is never a single item wearing a worse name.
    const segments = foldAllocation(Array.from({ length: 7 }, (_, i) => item(`k${i}`, 10)));
    expect(segments).toHaveLength(6);
    expect(segments[5]?.key).toBe('__other__');
    expect(segments[5]?.sources).toBe(2);
  });

  test('a sliver too thin to draw folds even when there is budget for it', () => {
    // 0.2% of a 256px phone bar is half a pixel: a segment nobody can see or
    // read a colour off. Folding it is honest; drawing it is not.
    const segments = foldAllocation([item('big', 998), item('sliver', 1), item('other', 1)]);
    expect(segments.map((s) => s.key)).toEqual(['big', '__other__']);
    expect(segments[1]?.sources).toBe(2);
    expect(segments.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 10);
  });

  test('a lone sliver stays folded — the threshold would do nothing otherwise', () => {
    const segments = foldAllocation([item('big', 999), item('sliver', 1)]);
    expect(segments.map((s) => s.key)).toEqual(['big', '__other__']);
  });

  test('maxSegments cannot be raised past the reserved slots', () => {
    const segments = foldAllocation(
      Array.from({ length: 10 }, (_, i) => item(`k${i}`, 10)),
      { maxSegments: 8 }
    );
    expect(segments).toHaveLength(CHART_SERIES_LIMIT);
  });

  test('maxSegments can be lowered for a tighter bar', () => {
    const segments = foldAllocation(
      Array.from({ length: 6 }, (_, i) => item(`k${i}`, 10)),
      { maxSegments: 3 }
    );
    expect(segments.map((s) => s.key)).toEqual(['k0', 'k1', '__other__']);
    expect(segments[2]?.sources).toBe(4);
  });
});
