/**
 * The maths behind a snap-point drawer, kept separate from the component
 * that renders it.
 *
 * A drawer's *position* here is the fraction of the viewport height it
 * occupies: `0.4` is the 40% rest state, `1` is full height, `0` is closed.
 * Velocity is the derivative of that, in fraction-of-viewport per
 * millisecond, positive when the drawer is growing.
 *
 * These are pure so the release rule — the one bit of a drag gesture that
 * is genuinely easy to get wrong, and impossible to eyeball once it ships —
 * is unit-testable without a DOM.
 */

/** How far past the tallest snap point a drag may stretch, as a fraction of
 * the overshoot. Below 1 the drawer resists rather than tearing off the top,
 * which is what makes the ceiling feel like a ceiling. */
const OVERSHOOT_RESISTANCE = 0.2;

/** A flick is judged on where it is heading, not where the finger left off.
 * 120ms of projected travel is short enough that a slow drag still lands on
 * the nearest point and long enough that a deliberate flick clears one. */
const PROJECTION_MS = 120;

/** Release below this fraction of the smallest snap point closes the drawer
 * rather than springing back — dragging a 40% drawer down to 15% is a
 * dismissal, not an undershoot. */
const CLOSE_FRACTION = 0.6;

export interface ReleaseOutcome {
  /** True when the gesture should dismiss the drawer entirely. */
  close: boolean;
  /** Index into the normalized snap points to settle on. Meaningless when
   * `close` is true; still valid so callers never branch to read it. */
  index: number;
}

/**
 * Sorted, deduplicated, in-range snap points. Throws rather than silently
 * repairing an empty list: a drawer with no snap points has no rest state,
 * and the failure is a programming error at the call site.
 */
export function normalizeSnapPoints(points: readonly number[]): number[] {
  const valid = points.filter((p) => Number.isFinite(p) && p > 0 && p <= 1);
  const unique = [...new Set(valid)].sort((a, b) => a - b);
  if (unique.length === 0) {
    throw new Error('snapPoints must contain at least one value in (0, 1]');
  }
  return unique;
}

/**
 * Where a drag actually puts the drawer. Downward travel is unclamped so a
 * dismissal gesture reads one-to-one under the finger; upward travel past
 * the tallest snap point is damped.
 */
export function clampDragPosition(position: number, snapPoints: readonly number[]): number {
  const max = snapPoints[snapPoints.length - 1] ?? 1;
  if (position > max) return max + (position - max) * OVERSHOOT_RESISTANCE;
  return Math.max(position, 0);
}

/** Index of the snap point closest to `position`. Ties go to the taller one,
 * which matches the expectation that a drawer released exactly between two
 * states opens rather than collapses. The epsilon is what makes that rule
 * hold at all: an exact midpoint between two snap points is never exactly
 * equidistant in binary floating point, so a strict comparison decides the
 * tie by rounding error instead of by intent. */
const TIE_EPSILON = 1e-9;

export function nearestSnapIndex(position: number, snapPoints: readonly number[]): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < snapPoints.length; i++) {
    const distance = Math.abs((snapPoints[i] as number) - position);
    if (distance <= bestDistance + TIE_EPSILON) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

export interface ReleaseOptions {
  /** `false` when the drawer may not be closed by a gesture — see
   *  `BottomDrawerContent`'s `dismissible`. A downward flick then settles on
   *  the shortest snap point instead of dismissing. */
  dismissible?: boolean;
  /**
   * The snap index the drag STARTED on. Supplying it turns on the detent rule
   * below; omitting it is the pre-SC-1151 behaviour, and every caller that
   * cannot say where the gesture began should omit it rather than guess.
   */
  from?: number;
}

/**
 * How far UP a drag must travel, as a fraction of the viewport, to count as
 * asking for the next stop rather than as a thumb that moved.
 *
 * 0.04 is ~34px on an 844px phone — an order of magnitude above Chrome's 8px
 * touch slop and the component's own 4px claim threshold, and well under the
 * smallest distance anybody drags on purpose.
 */
const DETENT_TRAVEL = 0.04;

/**
 * What a release does: settle on a snap point, or close.
 *
 * The projection term is what separates a flick from a drag. Without it a
 * fast upward flick that only travelled 5% snaps straight back, which reads
 * as the drawer refusing the gesture.
 *
 * `dismissible: false` is the one case where a flick past the close threshold
 * does *not* close: the drawer is showing something the reader cannot get
 * back, so the gesture settles at the shortest snap point and the sheet stays
 * up. Deciding that here rather than in the component keeps the whole release
 * rule in one testable place (SC-76).
 *
 * `from` adds the DETENT rule — see the comment on the branch itself. Without
 * it the projection term is the only thing separating a flick from a drag,
 * and it is calibrated in fractions of the VIEWPORT while the distance that
 * actually matters is the gap between two stops. On `PEEK_SNAP_POINTS` that
 * gap is half the viewport, so a flick had to clear 211px on a 390x844 phone
 * before anything at all happened (SC-1151).
 */
export function resolveRelease(
  position: number,
  velocity: number,
  snapPoints: readonly number[],
  { dismissible = true, from }: ReleaseOptions = {}
): ReleaseOutcome {
  const projected = position + velocity * PROJECTION_MS;
  const smallest = snapPoints[0] as number;
  if (projected < smallest * CLOSE_FRACTION) return { close: dismissible, index: 0 };
  const index = nearestSnapIndex(projected, snapPoints);
  if (from === undefined || index !== from) return { close: false, index };

  // The detent (SC-1151). Landing back on the stop the drag started from is
  // the one outcome that has to be looked at twice, because the sheet has
  // already TAKEN the gesture by then: `resolveDragClaim` gives it every
  // upward drag below the ceiling and `BottomDrawerContent` cancels the
  // `touchmove`, so the list under the finger could not scroll either. A
  // spring-back there is not a neutral "nothing happened" — it is a flick
  // that reached nothing at all, and with two stops half a viewport apart
  // every ordinary flick lands in it.
  //
  // Upward only, and that asymmetry is the safety half rather than an
  // oversight: a detent DOWN from the shortest stop is a dismissal, and a
  // downward drag is the reflex gesture that fires before the reader has
  // decided anything (SC-76). Down keeps the projection rule exactly as it
  // was.
  const origin = snapPoints[from];
  if (origin === undefined || position - origin < DETENT_TRAVEL) {
    return { close: false, index };
  }
  return { close: false, index: Math.min(from + 1, snapPoints.length - 1) };
}

/** Who a vertical gesture inside the drawer belongs to. */
export type DragClaim = 'sheet' | 'content';

export interface DragClaimInput {
  /** Travel since the gesture started, positive when the finger moves *down*
   *  the screen — the direction that shrinks the sheet. */
  deltaY: number;
  /** `scrollTop` of the nearest scrolling ancestor between the touched element
   *  and the sheet, or `null` when the gesture did not start over one. */
  scrollTop: number | null;
  /** True when the drawer is already at its tallest snap point. */
  atCeiling: boolean;
}

/**
 * Arbitration between the sheet's drag and the body's own scroll — the rule
 * that lets a drawer be dragged from anywhere rather than from the 36×4px
 * handle (SC-71 4.1).
 *
 * The drag surface used to be the handle alone, on the reasoning that
 * arbitrating with the inner scroll is easy to get wrong. It is — but the
 * result was a sheet whose core gesture worked in a ~50px strip and whose
 * second snap point was, in practice, unreachable. The arbitration is only two
 * questions, and both are answerable before the browser has committed to a
 * scroll:
 *
 * - **Down** moves the sheet whenever the list under the finger is already at
 *   its top. That is the overscroll a phone user expects: at `scrollTop 0` there
 *   is nothing left to scroll, so the gesture continues into the sheet instead
 *   of dying.
 * - **Up** grows the sheet until it is at its tallest, and only then scrolls the
 *   list. This is the iOS sheet idiom, and it is what makes the taller snap
 *   point reachable with the same flick that reveals the content it holds —
 *   rather than only by grabbing the handle.
 *
 * Pure, and separate from the component, for the reason the release rule is:
 * this is the decision that is impossible to eyeball once it ships.
 */
export function resolveDragClaim({ deltaY, scrollTop, atCeiling }: DragClaimInput): DragClaim {
  if (deltaY > 0) return scrollTop === null || scrollTop <= 0 ? 'sheet' : 'content';
  if (deltaY < 0) return atCeiling ? 'content' : 'sheet';
  // Horizontal, or no travel at all: nothing to claim yet.
  return 'content';
}
