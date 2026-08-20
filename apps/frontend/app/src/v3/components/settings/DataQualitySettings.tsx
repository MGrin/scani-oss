import { Skeleton } from '@scani/ui/ui/skeleton';
import { Block } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
        <h2 className="text-label text-muted-foreground">{t('v3.settings.dataQuality.title')}</h2>
        {/* The legend renders the SAME key the rows do (SC-269).
            
            It used to read "Anything in amber is worth looking into", and v3
            has no amber — the redesign removed it deliberately, as the note
            above says. A sentence naming the cue had outlived two cues by
            then: the colour it was written for, and "Look into this", which
            SC-268 replaced an hour before this was fixed.

            So it interpolates `dataQuality.flagged` rather than restating it.
            The legend cannot disagree with the label, because it IS the label
            — the next person to change the marker word changes this sentence
            with it and cannot forget to. That is the difference between a
            sentence that is true today and one that stays true.

            An instruction here is fine where the same words on a row were not
            (SC-268): prose describing a screen is a sentence, and the same
            words in the position a control occupies are a promise. */}
        <p className="text-body text-muted-foreground">
          {t('v3.settings.dataQuality.intro', {
            flag: t('v3.settings.dataQuality.flagged'),
          })}
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
          {dataQualityRows(t, reportQuery.data as DataQualityReport).map((row) => (
            <DataRow
              key={row.label}
              label={row.label}
              sublabel={row.hint}
              // Every label here is a sentence explaining a number, and the
              // ending is where the meaning is — "Shown positions with no
              // recent pri…", "An import that did not reach back bef…". On the
              // phone this was reported from there is no hover to recover it
              // (SC-200). The duplicate-token hint is worse still: the chips it
              // clips are where a Cyrillic lookalike of USDC would be visible
              // (SC-197).
              wrapIdentity
              value={<span className="tabular-nums">{row.value}</span>}
              // A STATE, not an instruction (SC-268), and it stays one.
              //
              // This read "Look into this": an imperative addressed to the
              // reader, in the zone where a row's controls live, on a row that
              // was a plain `<div>` — no `href`, no `onClick`, so no link, no
              // button, no focus ring, no tap target, and nothing announced as
              // actionable. The panel told the reader to act and handed them
              // nothing to act with.
              //
              // SC-293 built the destination rather than restoring the
              // sentence. A flagged row whose set the server named is now the
              // link (`row.href`), and the word in this zone is still the
              // finding rather than a command — "Flagged" is a claim about the
              // row; "Look into this" was a claim about what the interface
              // would do next, and the interface makes that claim by BEING a
              // link now. A row the server could not name a set for keeps the
              // word and stays inert, which is the state SC-268 bought.
              delta={
                row.warn ? (
                  <span className="text-muted-foreground">
                    {t('v3.settings.dataQuality.flagged')}
                  </span>
                ) : undefined
              }
              href={row.href}
              // The link's own name, because the row's content does not carry
              // its destination: read out whole it is a label, a figure and
              // the word "Flagged", none of which says where following it
              // goes. Named rather than described — "show in Holdings" is
              // where the link lands, not an instruction to the reader, and it
              // is only ever attached to a row that is a link.
              aria-label={
                row.href
                  ? t('v3.settings.dataQuality.rowLink', {
                      label: row.label,
                      count: row.value,
                    })
                  : undefined
              }
              className={cn(row.warn ? undefined : 'text-muted-foreground')}
            />
          ))}
        </DataRowList>
      )}
    </Block>
  );
}
