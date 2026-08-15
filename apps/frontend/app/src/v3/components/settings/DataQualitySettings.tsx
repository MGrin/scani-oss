import { Skeleton } from '@scani/ui/ui/skeleton';
import { Block } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { type DataQualityReport, dataQualityRows } from '../../lib/settings';

/**
 * The counters that used to be visible only in Sentry or a psql session:
 * duplicate token rows, zero-balance positions cluttering the list, positions
 * with no recent price, imports that synthesised a negative opening balance.
 *
 * A run of label/figure pairs, so `<DataRowList>` — v2 draws a two-column grid
 * of bordered boxes, which on a phone is seven boxes each holding one number.
 *
 * A counter worth looking into is marked by **weight, not colour**. v2 paints
 * it `text-amber-600`, a raw Tailwind palette value with no token behind it and
 * no dark-mode pair, and the v3 ramp has no amber to replace it with — `--loss`
 * is the wrong claim (none of these is an error the reader caused) and a
 * chart colour is not a semantic one. The row also carries "Look into this" in
 * words, because a weight difference is not a signal on its own.
 */
export function DataQualitySettings() {
  const reportQuery = trpc.portfolio.getDataQualityReport.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  // Silent on failure, deliberately: this block is diagnostics about the other
  // blocks. An error panel here would be the loudest thing on a screen where
  // it is the least important thing, and there is nothing the reader would do
  // about it.
  if (reportQuery.isError) return null;

  return (
    <Block className="flex flex-col">
      <div className="flex flex-col gap-1 p-4 pb-3">
        <h2 className="text-label text-muted-foreground">Data quality</h2>
        <p className="text-body text-muted-foreground">
          Recounted on every visit. Anything in amber is worth looking into.
        </p>
      </div>

      {reportQuery.isLoading || !reportQuery.data ? (
        <div className="flex flex-col gap-2 p-4 pt-0">
          <Skeleton className="h-8 w-full" aria-hidden="true" />
          <Skeleton className="h-8 w-full" aria-hidden="true" />
          <Skeleton className="h-8 w-full" aria-hidden="true" />
        </div>
      ) : (
        <DataRowList className="border-t border-border">
          {dataQualityRows(reportQuery.data as DataQualityReport).map((row) => (
            <DataRow
              key={row.label}
              label={row.label}
              sublabel={row.hint}
              value={<span className="tabular-nums">{row.value}</span>}
              delta={
                row.warn ? <span className="text-muted-foreground">Look into this</span> : undefined
              }
              className={cn(row.warn ? undefined : 'text-muted-foreground')}
            />
          ))}
        </DataRowList>
      )}
    </Block>
  );
}
