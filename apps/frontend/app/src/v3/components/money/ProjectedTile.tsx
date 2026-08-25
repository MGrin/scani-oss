import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * A figure that is a CLAIM ABOUT THE FUTURE, and the deliberate twin of
 * `<StatTile>` rather than a prop on it.
 *
 * SC-461's third constraint: never render a projection in the same visual
 * language as a measured figure. That is a rule about a whole surface, not
 * about one number, so it is kept by a separate component — a `projected`
 * boolean on `StatTile` would put the two presentations one default apart, and
 * the default would be the wrong one. Reaching for a projected figure has to be
 * a decision, and it is: you have to import a different tile.
 *
 * Three channels carry the claim, because one is never enough — colour fails in
 * greyscale and for a colour-blind reader, and a word alone is skipped by
 * everyone who is scanning for a number:
 *
 * 1. **The word, on every tile.** Not once at the top of the screen, where it
 *    scrolls away from the figure it qualifies.
 * 2. **A dashed rule**, on the badge here and on the `<Block>` these sit in and
 *    on the chart line — the same mark everywhere on the surface, so "dashed
 *    means projected" is learnable from one screen.
 * 3. **The figure never takes `--gain` or `--loss`.** A forecast has no
 *    measured direction; tinting a projected rise green is the interface
 *    agreeing with a guess.
 *
 * Layout is `<StatTile>`'s exactly — label, figure, note, in that order — so
 * the two read as siblings rather than as an unrelated widget. It is the
 * treatment that differs, not the anatomy.
 */

interface ProjectedTileProps {
  /** Sentence case, no trailing colon — same rule as `<StatTile>`. */
  label: string;
  /** A `<Numeric>` in almost every case. */
  value: ReactNode;
  /** One line under the figure, for what the figure does not cover. */
  note?: ReactNode;
  /** A view has one hero. On this surface that is the runway. */
  emphasis?: 'default' | 'hero';
  className?: string;
}

export function ProjectedTile({
  label,
  value,
  note,
  emphasis = 'default',
  className,
}: ProjectedTileProps) {
  const { t } = useTranslation();
  const hero = emphasis === 'hero';

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
        {label}
        {/* `text-caption` (13px), not smaller: 13px is v3's type floor and a
            badge is not exempt from it (SC-71 6.1). It is a `<span>` rather
            than the shared `<Badge>` because every `<Badge>` variant is a
            filled solid — the one thing this must not be. */}
        <span className="rounded border border-dashed border-muted-foreground/70 px-1.5 text-caption uppercase leading-tight tracking-wide">
          {t('v3.money.forecast.projectedMark')}
        </span>
      </span>
      <span className={hero ? 'text-display' : 'text-title'}>{value}</span>
      {note ? <p className="mt-1 text-caption text-muted-foreground">{note}</p> : null}
    </div>
  );
}
