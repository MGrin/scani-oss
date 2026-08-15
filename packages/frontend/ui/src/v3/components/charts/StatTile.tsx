import type { ReactNode } from 'react';
import { cn } from '../../../lib/cn';

/**
 * Label, figure, delta, trend — in that order, top to bottom. The data-viz
 * stat-tile contract, and the block the v3 home screen is built out of.
 *
 * `value`, `delta` and `trend` are nodes rather than data because v3 already
 * has one component that owns figure formatting (`<Numeric>`, V3-07) and one
 * that owns changes (`<DeltaPill>`); re-declaring their props here would mean
 * a second place for currency, decimals and compaction to disagree. Same
 * choice `<DataRow>` makes, for the same reason.
 *
 * The `hero` emphasis is the "how much do I have" number from §2.1 — display
 * size, one per view. Everything else is a `default` tile. The rule the prop
 * exists to keep is that a view has exactly one hero: three equal-weight
 * figures is what `DashboardPage.tsx` does today, and it is why v2's home
 * screen answers no question at a glance.
 */

interface StatTileProps {
  /** Sentence case, no trailing colon. */
  label: string;
  /** A `<Numeric>` in almost every case. */
  value: ReactNode;
  /** A `<DeltaPill>` in almost every case. */
  delta?: ReactNode;
  /** A `<Sparkline>` in almost every case. */
  trend?: ReactNode;
  emphasis?: 'default' | 'hero';
  className?: string;
}

export function StatTile({
  label,
  value,
  delta,
  trend,
  emphasis = 'default',
  className,
}: StatTileProps) {
  const hero = emphasis === 'hero';

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {/* The label leads because it is what makes the figure mean anything,
          but it is caption-weight: on a phone the eye should land on the
          number and read the label second. */}
      <span className="text-caption text-muted-foreground">{label}</span>
      {/* No `data-figure-line` here, deliberately: a tile is often a flex item
          whose own width comes from this figure, and a size container's inline
          size must not depend on its contents — declaring the line here
          collapsed the tile to its label. The line the SC-72 fit rule measures
          against is the `<Block>` the tile sits in. */}
      <span className={hero ? 'text-display' : 'text-title'}>{value}</span>
      {delta ? <span className="mt-1 flex items-center">{delta}</span> : null}
      {/* Last, and full width. A sparkline is the least precise thing in the
          tile, so it sits below everything that carries an actual value. */}
      {trend ? <div className="mt-2">{trend}</div> : null}
    </div>
  );
}
