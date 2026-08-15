/**
 * The pure half of the v3 chart language: which colour a series gets, and how
 * a list of parts becomes the segments of an allocation bar.
 *
 * Kept free of React so the two rules that are easy to get wrong — colour
 * follows the entity rather than its rank, and a bar never renders a segment
 * too thin to see — are testable without rendering anything.
 */

/** Slots defined in `v3-tokens.css`. Assigned in order, never cycled. */
export const CHART_SLOT_COUNT = 8;

/**
 * How many slots an allocation bar may spend before folding into "Other".
 *
 * Six rather than eight is a colour decision, not a density one. Slot 7 is
 * `--interactive`'s hue and slot 8 is `--loss`'s, so a segment reaching either
 * would read as a tappable affordance or as a falling figure. The token file
 * documents the measured distances; `v3-tokens.test.ts` asserts that those two
 * slots are the colliding ones, so this constant cannot silently stop being
 * the right number.
 */
export const CHART_SERIES_LIMIT = 6;

/**
 * Below this share a segment is thinner than a hairline on a phone, where the
 * bar is about 256px wide. Rendering it anyway produces a sliver nobody can
 * see or read a colour off; folding it into "Other" is the honest answer, and
 * it also keeps every segment wide enough that the 2px surface gaps between
 * them stay proportionally negligible.
 */
export const MIN_VISIBLE_SHARE = 0.01;

/**
 * A CSS custom property rather than a resolved colour, so a theme flip
 * repaints without React re-rendering and without the hue changing. Recharts
 * writes `fill` / `stroke` as presentation attributes, which browsers parse as
 * CSS and therefore resolve `var()` in.
 */
export function chartSlotColor(slot: number): string {
  if (!Number.isInteger(slot) || slot < 1 || slot > CHART_SLOT_COUNT) {
    throw new RangeError(`chart slot out of range: ${slot}`);
  }
  return `hsl(var(--chart-${slot}))`;
}

export const CHART_OTHER_COLOR = 'hsl(var(--chart-other))';

/**
 * The key `foldAllocation` gives the segment it folds the tail into.
 *
 * Exported because "Other" is the one segment that stands for no record, so a
 * caller turning segments into links has to be able to recognise it — and
 * recognising it by its *label* would break the moment a caller passes
 * `otherLabel`.
 */
export const ALLOCATION_OTHER_KEY = '__other__';

export interface AllocationInput {
  /** Stable identity. Not displayed. */
  key: string;
  label: string;
  /** Any unit, as long as every item shares it. Non-positive values are dropped. */
  value: number;
}

export interface AllocationSegment extends AllocationInput {
  /** Fraction of the total, 0-1. Segments always sum to 1. */
  share: number;
  /** A `hsl(var(--chart-*))` reference. */
  color: string;
  /** How many inputs this segment stands for. 1 unless it is the fold. */
  sources: number;
}

export interface FoldAllocationOptions {
  maxSegments?: number;
  minShare?: number;
  otherLabel?: string;
}

/**
 * Turns a list of parts into the segments of a stacked bar.
 *
 * **Order is the caller's, and colour follows it.** Slot N goes to the Nth
 * input, so a series keeps its colour when a sibling's value changes — the
 * data-viz rule that colour encodes the entity and never its rank. Sorting the
 * input by current value would satisfy the eye once and then repaint the whole
 * bar the next time the prices moved, which is precisely the failure the rule
 * exists to prevent. A caller that wants biggest-first should sort on a stable
 * key upstream, once.
 *
 * The fold is therefore always the *tail* of the input plus anything too thin
 * to see, which keeps the slots the bar spends contiguous (1..N). That matters
 * beyond tidiness: the palette's colourblind separation was validated on
 * adjacent pairs, so a bar rendering slots 1, 2 and 4 would put an untested
 * pair side by side.
 */
export function foldAllocation(
  items: readonly AllocationInput[],
  {
    maxSegments = CHART_SERIES_LIMIT,
    minShare = MIN_VISIBLE_SHARE,
    otherLabel = 'Other',
  }: FoldAllocationOptions = {}
): AllocationSegment[] {
  // A share-of-total bar has no way to draw a negative part, and a zero part
  // has no width — both are dropped rather than rendered as nothing.
  const positive = items.filter((item) => Number.isFinite(item.value) && item.value > 0);
  const total = positive.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0) return [];

  const slots = Math.min(Math.max(maxSegments, 1), CHART_SERIES_LIMIT);
  // One slot is held back for "Other" as soon as the parts outnumber the
  // budget. A side effect worth naming: a budget-triggered fold always stands
  // for at least two parts, so "Other" is never one item wearing a worse name.
  const keepable = positive.length > slots ? slots - 1 : slots;

  const kept: AllocationSegment[] = [];
  const folded: AllocationInput[] = [];

  for (const item of positive) {
    const share = item.value / total;
    if (kept.length < keepable && share >= minShare) {
      kept.push({ ...item, share, color: chartSlotColor(kept.length + 1), sources: 1 });
    } else {
      folded.push(item);
    }
  }

  if (folded.length === 0) return kept;

  const foldedValue = folded.reduce((sum, item) => sum + item.value, 0);
  return [
    ...kept,
    {
      key: ALLOCATION_OTHER_KEY,
      label: otherLabel,
      value: foldedValue,
      share: foldedValue / total,
      color: CHART_OTHER_COLOR,
      sources: folded.length,
    },
  ];
}
