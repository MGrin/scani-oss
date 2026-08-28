import { Numeric } from '@scani/ui/v3/components/Numeric';
import { TruncatedText } from '@scani/ui/v3/components/TruncatedText';
import {
  type AllocationInput,
  type AllocationSegment,
  foldAllocation,
} from '@scani/ui/v3/lib/chart';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

/**
 * Allocation as one horizontal stacked bar plus its item list — §2.1 of the
 * research brief, replacing v2's donut.
 *
 * The donut's problem was never the shape, it was that a donut cannot label
 * itself: it needs a legend that is pure colour key, so the reader pays for a
 * second block of vertical space that carries no numbers. The bar plus a list
 * costs about a third of the donut's height and the list carries the values,
 * so it replaces the donut, its legend *and* the separate figures beneath.
 *
 * The list is not optional chrome. Interior segments of a stacked bar have no
 * free end to hang a label off, so the data-viz guidance is to let the legend
 * carry them rather than cram text into a fill — and three of the light-theme
 * palette steps sit below 3:1 on a white page, which obligates exactly this
 * relief channel. Dropping the list to save space would break both rules at
 * once.
 */

/** The list row's three zones — swatch, name, figures — shared by the inert
 *  row and the linked one so the two are the same object at the same size. */
const ROW = 'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3';

interface AllocationBarProps {
  /**
   * In the order they should be displayed and coloured. Slot N goes to the Nth
   * item, so this order must be stable across renders — see `foldAllocation`.
   */
  items: readonly AllocationInput[];
  currency: string;
  /** Names the bar for assistive tech; the list beneath carries the values. */
  label: string;
  maxSegments?: number;
  /**
   * Where a segment's slice can be read in full, or `null` for one that stands
   * for no record — "Other", and anything the caller cannot address.
   *
   * Optional because a bar summarising a list the reader is already looking at
   * (`HoldingsSummary`, `EntityValueSummary`) has nowhere to send them: the
   * destination is the screen they are on. Omitted, the list stays inert text,
   * which is what a legend is.
   */
  itemHref?: (segment: AllocationSegment) => string | null;
  className?: string;
}

export function AllocationBar({
  items,
  currency,
  label,
  maxSegments,
  itemHref,
  className,
}: AllocationBarProps) {
  const segments = foldAllocation(items, maxSegments === undefined ? {} : { maxSegments });
  if (segments.length === 0) return null;

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {/* `gap` in the page colour is the separator, not a stroke around each
          segment: a border would add ink that is not data, and on a 2px-thin
          neighbour it would be most of the segment. `overflow-hidden` on a
          fully-rounded track is what rounds the two data ends while leaving
          the interior joins square. */}
      <div
        role="img"
        aria-label={label}
        // A stable hook for the visual gate, which must confirm this bar is
        // FOLDED before committing a baseline of it (SC-815). The page carries
        // 21 `role="img"` nodes — every institution mark is one — so a
        // structural selector picks whichever comes first, and matching on
        // `aria-label` would tie the harness to a translated string.
        data-ui="allocation-bar"
        className="flex h-2 gap-[2px] overflow-hidden rounded-full"
      >
        {segments.map((segment) => (
          <div
            key={segment.key}
            // `flex-grow: share` with a zero basis divides the space *after*
            // the gaps are taken out, so the gaps never distort the
            // proportions. Widths in `%` would sum past 100 and let flexbox
            // shrink the segments by an amount that depends on how many there
            // are.
            style={{ flex: `${segment.share} 0 0px`, backgroundColor: segment.color }}
          />
        ))}
      </div>

      {/* Capped rather than full-bleed (SC-71 8.3). Every row here pairs a name
          on the left with its value on the right, and on a wide card the two
          ended up ~1,550px apart at 1920 — the same failure `PageLayout`'s
          measures exist to prevent, one level down. 34rem is a little over the
          phone measure, which is the width the pairing was designed at. */}
      {/* No gap once the rows are controls: on touch each one is 44px tall
          (`a[href]` under `pointer: coarse`), and 8px of air on top of that
          reads as three floating lines rather than one list. Flush, the rows
          are their own rhythm and a hover fill meets its neighbour's, which is
          what every other run of rows in v3 does. */}
      <ul className={cn('flex max-w-[34rem] flex-col', itemHref ? 'gap-0' : 'gap-2')}>
        {segments.map((segment) => {
          const zones = (
            <>
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: segment.color }}
              />
              {/* The name is the zone that gives way here, so it is the one
                  that has to hand back what it cut (SC-114). */}
              <TruncatedText className="truncate text-label">
                {segment.label}
                {segment.sources > 1 ? (
                  <span className="text-muted-foreground"> · {segment.sources}</span>
                ) : null}
              </TruncatedText>
              <span className="flex items-baseline gap-2 whitespace-nowrap">
                <Numeric value={segment.value} currency={currency} compact className="text-label" />
                <Numeric
                  value={segment.share * 100}
                  format="percent"
                  decimals={0}
                  className="w-10 text-end text-caption text-muted-foreground"
                />
              </span>
            </>
          );
          const href = itemHref?.(segment) ?? null;
          return (
            <li key={segment.key}>
              {href === null ? (
                // Inert inside a linked list — the fold, an unaddressable part —
                // takes the same padding so it keeps the list's rhythm.
                <span data-figure-line="true" className={cn(ROW, itemHref && 'py-1')}>
                  {zones}
                </span>
              ) : (
                // Bled outwards by the padding it adds, so a linked list sits on
                // exactly the type grid an inert one does — the fill and the
                // focus ring reach past the text without moving it.
                <Link
                  to={href}
                  // The row is the figure's line (SC-72), for the reason
                  // `DataRow` gives: the value zone is an `auto` track sized
                  // *by* the figure in it.
                  data-figure-line="true"
                  className={cn(
                    ROW,
                    '-mx-2 rounded-md px-2 py-1',
                    'transition-colors duration-fast ease-emphasized',
                    // `--surface-hover` rather than `--surface-2`, which is
                    // white on the V3-23 light page and would not show.
                    'hover:bg-surface-hover active:bg-surface-hover',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                  )}
                >
                  {zones}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
