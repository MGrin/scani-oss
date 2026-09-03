import { cloneElement, type ReactElement } from 'react';
import { ResponsiveContainer } from 'recharts';
import { cn } from '../../../lib/cn';

/**
 * The v3 wrapper around recharts. Every chart in v3 goes through it.
 *
 * It is deliberately thin, because the thing that makes a recharts chart
 * theme-stable is not a React abstraction — it is that series colours are
 * passed as `hsl(var(--chart-N))` rather than resolved hexes. Recharts writes
 * `fill` and `stroke` as presentation attributes, which browsers parse as CSS
 * and therefore resolve `var()` in, so a theme flip repaints the chart with no
 * re-render, no `useTheme()`, and no chance of the two themes disagreeing about
 * which colour a series is. Resolving tokens to hex in JS is the tempting
 * alternative and it is how the ramp drifts: the value is read once, at mount,
 * against whichever theme happened to be live.
 *
 * What the frame itself owns is the accessibility contract. An SVG full of
 * `<path>` elements is meaningless to a screen reader, so the chart is one
 * labelled image and the surrounding markup — the stat tile's figure, the
 * allocation bar's item list — carries the actual values. That is also the
 * relief channel the palette's light steps require, so it is not optional
 * decoration.
 *
 * Owning that contract now means **enforcing** it on the recharts surface
 * underneath, which is why the child is cloned. Since recharts 3 the chart's
 * `accessibilityLayer` defaults on, and it puts `role="application"` and
 * `tabIndex="0"` on the `<svg>` with no name of its own — so the home screen's
 * chart was the second Tab stop in the main column, announced nothing, and
 * `role="application"` additionally makes assistive tech hand its own keys to a
 * widget that has no key handling to hand them to (SC-71 7.1). One labelled
 * image means one node in the tree: the `<svg>` is presentational and out of
 * the tab order, and this element is the whole announcement.
 */

/** Attributes forced onto the recharts surface. `role` and `tabIndex` are read
 *  off the chart's own props by recharts' `MainChartSurface`, which is what
 *  makes overriding its accessibility-layer defaults possible at all. */
const PRESENTATIONAL_SURFACE = { role: 'presentation', tabIndex: -1 } as const;

interface ChartFrameProps {
  /**
   * What the chart shows, as a sentence. Not "chart" or "graph" — the role
   * already says that. "Net worth over the last 30 days, rising" is the shape.
   */
  label: string;
  /** Fixed, in px. Charts size their width fluidly and their height never. */
  height: number;
  className?: string;
  /** A single recharts chart element. */
  children: ReactElement;
}

export function ChartFrame({ label, height, className, children }: ChartFrameProps) {
  return (
    // `w-full` and an explicit height rather than an aspect ratio:
    // ResponsiveContainer measures its parent, and a parent sized by its own
    // content measures as zero.
    // `dir="ltr"` is load-bearing under RTL, and it is not a claim that a chart
    // should read left to right (SC-969). SVG `text-anchor` is DIRECTION-
    // relative — `end` means the physical left under `dir="rtl"` — while every
    // coordinate recharts computes is physical. Measured on the committed
    // baselines at `bac193fd3`: the home chart's plot area is identical in both
    // directions (gridline x=97..355 in each), and the `$193.2K` tick moved from
    // x=37..88 to x=89..140 — the same 51px of text, flipped to the far side of
    // an anchor that had not moved, drawn over the gridline it labels. Anchoring
    // physically here is what lets a chart choose its axis SIDE deliberately,
    // which `orientation` on the y-axis then does. Same reasoning as
    // `NetWorthTape`'s figure: a thing laid out from coordinates is not prose.
    //
    // It reaches the tooltip too, which recharts renders inside this box. That
    // is not a cost today and is why the scope is left this wide: an axis date
    // is `4 Mar` in every other place on the screen (SC-175) and RTL bidi was
    // reordering it to `Mar 4` — the space between a number and a word takes
    // the paragraph direction — so the tooltip's own date was reordered the
    // same way. What it WOULD cost is a future Arabic string in the tooltip
    // laid out under an LTR paragraph direction; a wholly-RTL run still renders
    // right to left, so that is a difference in edge punctuation, not in words.
    <div
      dir="ltr"
      role="img"
      aria-label={label}
      className={cn('w-full', className)}
      style={{ height }}
    >
      {/* `height` in px, not `"100%"`: a percentage makes recharts re-derive
          from a ResizeObserver a number this component was handed directly, and
          until that observer's first callback the height is the container's
          `initialDimension` of -1 — one `width(-1) and height(-1)` warning per
          chart on every mount, so four on cloud's usage page (SC-126). Width
          stays fluid and measured; that one genuinely is not known here. */}
      <ResponsiveContainer width="100%" height={height}>
        {cloneElement(children, PRESENTATIONAL_SURFACE)}
      </ResponsiveContainer>
    </div>
  );
}
