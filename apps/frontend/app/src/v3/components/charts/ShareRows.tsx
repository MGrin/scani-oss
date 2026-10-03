import { Numeric } from '@scani/ui/v3/components/Numeric';
import { TruncatedText } from '@scani/ui/v3/components/TruncatedText';
import { CHART_OTHER_COLOR } from '@scani/ui/v3/lib/chart';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import type { ShareRow } from '../../lib/home';

/**
 * Parts that may overlap, each drawn as its own share of the whole (SC-1469).
 *
 * `AllocationBar` is the wrong picture for these: a stacked bar says its parts
 * partition the whole, and groups do not — a holding in three groups counts in
 * full in each. So every row carries its own 0–100% meter, and two rows can
 * both read 60%.
 *
 * Every meter is the fold's neutral rather than a chart slot. A slot per row
 * would read as a legend for a split, which is the claim this replaces.
 */
export function ShareRows({
  rows,
  currency,
  label,
  note,
  shareCaption,
  itemHref,
}: {
  rows: readonly ShareRow[];
  currency: string;
  /** Names the list for assistive tech. */
  label: string;
  /** Said under the rows when they add up to more than the whole. */
  note: string | null;
  /** As on `AllocationBar`: names the whole when it is not net worth (SC-1463). */
  shareCaption?: string;
  itemHref?: (row: ShareRow) => string | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      {shareCaption ? (
        <p className="max-w-[34rem] text-end text-caption text-muted-foreground">{shareCaption}</p>
      ) : null}

      <ul aria-label={label} className="flex max-w-[34rem] flex-col">
        {rows.map((row) => {
          const zones = (
            <>
              <span className="flex items-baseline justify-between gap-3">
                <TruncatedText className="truncate text-label">{row.label}</TruncatedText>
                <span className="flex items-baseline gap-2 whitespace-nowrap">
                  <Numeric value={row.value} currency={currency} compact className="text-label" />
                  <Numeric
                    value={row.share === null ? null : row.share * 100}
                    format="percent"
                    decimals={0}
                    className="w-10 text-end text-caption text-muted-foreground"
                  />
                </span>
              </span>
              {row.share === null ? null : (
                // The percentage beside it is what a screen reader hears; the
                // meter repeats it for the eye.
                <span
                  aria-hidden="true"
                  data-ui="share-meter"
                  className="block h-1 overflow-hidden rounded-full bg-muted"
                >
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.min(row.share, 1) * 100}%`,
                      backgroundColor: CHART_OTHER_COLOR,
                    }}
                  />
                </span>
              )}
            </>
          );
          const href = itemHref?.(row) ?? null;
          const column = 'flex flex-col gap-1.5 py-1.5';
          return (
            <li key={row.key}>
              {href === null ? (
                <span data-figure-line="true" className={column}>
                  {zones}
                </span>
              ) : (
                <Link
                  to={href}
                  data-figure-line="true"
                  className={cn(
                    column,
                    '-mx-2 rounded-md px-2',
                    'transition-colors duration-fast ease-emphasized',
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

      {note ? <p className="max-w-[34rem] text-caption text-muted-foreground">{note}</p> : null}
    </div>
  );
}
