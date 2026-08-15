import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * The one place a v3 screen decides how wide it is, and the grid a dashboard
 * composes into above `lg`.
 *
 * Before this, six files each hard-coded their own cap — `560`, `560 lg:880`,
 * `1100`, and `PageColumn`'s two — which is how the desktop rendering became a
 * phone column centred in an empty window. The caps were never wrong for a
 * phone; there was simply no desktop counterpart, and nothing stopped a
 * seventh screen inventing a seventh number.
 *
 * So the prop is an **intent**, not a width. A screen says what it is — a form,
 * a list, a dashboard — and the measure follows. That is the part that cannot
 * drift: adding a screen means picking one of three words, and widening the
 * form measure is one edit here rather than a grep.
 *
 * **Below `lg` every measure is the phone layout unchanged.** The desktop
 * treatment is additive: a `lg:` step on the cap and, for `grid`, a real
 * multi-column placement. `narrow`'s 560 and `wide`'s 1100 are the numbers the
 * pages already carried, so a phone renders byte-identically to before.
 */

/**
 * - `narrow` — a form, or a screen that stays one reading column at every
 *   width. 840 above `lg` because that is what two ~400px field columns and the
 *   gap between them need; below that a paired row is narrower than a single
 *   field and the pairing stops being worth it.
 * - `wide` — a list that becomes a table above `lg`. Keeps climbing past `xl`
 *   because a table is the one thing that genuinely converts width into rows
 *   you can read without scrolling sideways.
 * - `grid` — a dashboard. Same phone column as `narrow`, then the widest
 *   measure, because it is the only surface that fills the width with parallel
 *   blocks rather than one long line of text.
 *
 * Nothing goes edge-to-edge. Past ~1720 a row's label and its value sit far
 * enough apart that pairing them costs a saccade, which is the same failure as
 * the horizontal-scroll table, just at the other end.
 */
const MEASURES = {
  narrow: 'max-w-[560px] lg:max-w-[840px]',
  wide: 'max-w-[1100px] xl:max-w-[1400px] 2xl:max-w-[1720px]',
  grid: 'max-w-[560px] lg:max-w-[1180px] xl:max-w-[1440px] 2xl:max-w-[1720px]',
} as const;

export type PageMeasure = keyof typeof MEASURES;

/**
 * Gutters widen and vertical rhythm tightens above `lg`, which is the density
 * half of this ticket. A phone is short and wide-margined by the hardware, so
 * it spends its scarce width on content and its plentiful scroll on air; a
 * desktop window is the opposite, and 24px of dead space above the first block
 * is 24px of the fold spent on nothing.
 */
const PADDING = 'px-4 py-6 lg:px-6 lg:py-5';

interface PageLayoutProps {
  children: ReactNode;
  /** What this screen *is*. Picks the measure; never pick a width directly. */
  measure?: PageMeasure;
  className?: string;
}

export function PageLayout({ children, measure = 'narrow', className }: PageLayoutProps) {
  return (
    <div
      // The outermost figure line (SC-72). Surfaces that own a figure's box
      // declare a nearer one; this is the backstop, and it is what makes "a
      // figure never reaches past the page gutter" true by construction rather
      // than by remembering. Without a container anywhere above it the fit rule
      // falls back to the viewport, which is the right width measured from the
      // wrong origin.
      data-figure-line="true"
      className={cn('mx-auto flex w-full flex-col gap-4', MEASURES[measure], PADDING, className)}
    >
      {children}
    </div>
  );
}

interface PageHeaderProps {
  title: string;
  /** The one thing this screen exists to let you start. */
  action?: ReactNode;
}

export function PageHeader({ title, action }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h1 className="text-title">{title}</h1>
      {action}
    </div>
  );
}

/**
 * Twelve columns, because it is the smallest number divisible by both 2 and 3 —
 * halves and thirds are the two splits a dashboard actually wants, and a grid
 * that cannot express both forces one of them into a nested container.
 */
const SPANS = {
  full: 'lg:col-span-12',
  'two-thirds': 'lg:col-span-8',
  half: 'lg:col-span-6',
  third: 'lg:col-span-4',
} as const;

export type DashboardSpan = keyof typeof SPANS;

/**
 * The dashboard's composition container — a `PageLayout measure="grid"` whose
 * children are placed rather than stacked.
 *
 * It takes **any** number of children and reads a span hint off each one, so
 * the surface that owns the blocks can add, remove and reorder them without
 * this file knowing what any of them are. That separation is deliberate: the
 * home screen's contents and the home screen's layout are two different
 * tickets, and they were going to collide in one file otherwise.
 *
 * Below `lg` this is a single flex column in **source order** — which is why
 * source order has to be the phone order. There is no `order-*` escape: a
 * desktop arrangement that needs a different sequence than the phone one is two
 * designs, and reading order and DOM order diverging is also how the screen
 * reader loses the plot.
 */
export function DashboardGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      // Same backstop as `PageLayout` — the dashboard is the other thing a v3
      // page can be, and a figure inside it needs a line just as much.
      data-figure-line="true"
      className={cn(
        'mx-auto w-full',
        MEASURES.grid,
        PADDING,
        // One declaration set, two layouts: `flex-col` is inert once
        // `lg:grid` takes over, so the phone stack costs nothing above `lg`
        // and the grid costs nothing below it.
        //
        // No `items-start`: grid's default `stretch` is what makes two cards
        // sharing a row end on the same line. Left to their natural heights
        // they bottom out wherever their content happens to stop, and a row of
        // ragged cards reads as a rendering fault rather than a layout.
        'flex flex-col gap-6 lg:grid lg:grid-cols-12 lg:gap-4',
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * `min-w-0` on every item: a grid child's default `min-width: auto` refuses to
 * shrink below its content, so one wide table or one long unbroken figure
 * silently pushes its neighbour out of the row. This is the same fix
 * `DataRow`'s identity zone carries, for the same reason.
 *
 * `*:flex-1` hands the stretched item's full height down to the card inside
 * it. Without it the item stretches and the card does not, which puts the
 * card's bottom edge back where it started and makes the whole stretch
 * invisible — the item is a placement wrapper, and the visible surface is
 * always its child.
 */
export function DashboardItem({
  children,
  span = 'full',
  className,
}: {
  children: ReactNode;
  /** How much of the twelve-column row this block claims above `lg`. */
  span?: DashboardSpan;
  className?: string;
}) {
  return (
    <div
      // A dashboard column is a nearer figure line than the grid around it:
      // above `lg` a `third` is a quarter of the measure, and a figure sized
      // against the whole grid would overflow it.
      data-figure-line="true"
      className={cn('flex min-w-0 flex-col lg:[&>*]:flex-1', SPANS[span], className)}
    >
      {children}
    </div>
  );
}
