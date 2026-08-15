/**
 * The one question pull-to-refresh has to get right: does this touch belong
 * to the page's own scroller, or to something scrollable sitting inside it?
 *
 * The rule this replaces armed on `scrollTop <= 1` and refused only on
 * `table, .overflow-x-auto`. That is wrong twice over. A sheet, a drawer or a
 * `ScrollArea` resting at the top of its *own* scroll container reports the
 * page scroller's `scrollTop` — 0, because the page did not move — so pulling
 * down inside an open sheet refreshed the page underneath it. And a region
 * that scrolls *vertically* was never excluded at all, which is the common
 * case: v3 stacks a drawer, a peek sheet, a refine sheet and `ScrollArea`
 * inside one shell.
 *
 * The decision is made from selectors and ancestry alone — no `scrollTop`,
 * no `getComputedStyle`, no geometry. Two reasons:
 *
 * 1. It runs in `touchstart`. A layout read there costs a forced reflow on
 *    the first frame of every gesture the user makes.
 * 2. Geometry cannot answer it anyway. `scrollHeight > clientHeight` is just
 *    as true of a plain `<main>` full of tall content under `overflow:
 *    visible` as it is of a real scroll region, so measuring would refuse the
 *    gesture everywhere.
 *
 * Every scrollable surface in these apps is *declared* — a Tailwind overflow
 * class, or a primitive's data attribute — so asking what an element is
 * answers what measuring it cannot.
 */

/**
 * Structural subset of `Element` this needs. Declaring it means the rule is
 * testable in `bun test`, which has no DOM: a fake node with `matches` and
 * `parentElement` is enough, and a real `Element` satisfies it as-is.
 */
export interface PullGestureNode {
  readonly parentElement: PullGestureNode | null;
  matches(selectors: string): boolean;
}

/** Anything between the touch and the page scroller that owns its own scroll. */
export const NESTED_SCROLL_SELECTOR = [
  // Radix `ScrollArea` — the element that actually scrolls is the viewport.
  '[data-radix-scroll-area-viewport]',
  // Every sheet, drawer and dialog in @scani/ui is built on Radix Dialog, so
  // one role covers `Sheet`, `BottomDrawer` and `Dialog` alike. Overlays are
  // portalled beside the scroller rather than inside it, so this is belt and
  // braces — but the portal container is configurable (V3-22) and a sheet
  // landing inside the scroller must not become a refresh.
  '[role="dialog"]',
  // Tailwind's scroll containers, both axes.
  '.overflow-auto',
  '.overflow-scroll',
  '.overflow-x-auto',
  '.overflow-x-scroll',
  '.overflow-y-auto',
  '.overflow-y-scroll',
  // A table wide enough to matter scrolls sideways under the finger.
  'table',
  // Opt-out for anything that reads the same gesture itself — a chart being
  // panned, a carousel, a draggable row.
  '[data-no-pull-to-refresh]',
].join(',');

export type PullArmDecision =
  | { armed: true }
  | { armed: false; reason: 'no-target' | 'outside-scroller' | 'nested-scroll' };

/**
 * Whether a gesture starting on `target` may arm pull-to-refresh for
 * `scroller`. Says nothing about scroll position or direction — those are the
 * caller's, and change during the gesture; this does not.
 */
export function canArmPullToRefresh(
  target: PullGestureNode | null | undefined,
  scroller: PullGestureNode
): PullArmDecision {
  if (!target) return { armed: false, reason: 'no-target' };

  let node: PullGestureNode | null = target;
  while (node && node !== scroller) {
    if (node.matches(NESTED_SCROLL_SELECTOR)) {
      return { armed: false, reason: 'nested-scroll' };
    }
    node = node.parentElement;
  }

  // Walking off the top of the tree means the touch was never inside the
  // scroller at all — a portalled overlay, or a fixed bar over the page.
  return node === scroller ? { armed: true } : { armed: false, reason: 'outside-scroller' };
}
