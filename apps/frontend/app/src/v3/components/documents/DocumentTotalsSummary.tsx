import { formatBytes } from '@scani/shared';
import { Block } from '@scani/ui/v3/components/Block';
import { StatTile } from '@scani/ui/v3/components/charts/StatTile';
import { useTranslation } from 'react-i18next';
import { type DocumentRow, documentTotals } from '../../lib/documents';

/**
 * What the files on screen add up to.
 *
 * Same contract as `EntityValueSummary` and for the same reason: it is a
 * `summary` on the data view, so it receives the **filtered** set, and the
 * count line directly below already says "3 of 12 files".
 *
 * Storage used is the hero because it is the only figure on this screen that
 * accumulates without anyone deciding to let it — the reason a Files page is
 * worth having at all. Invoices found is beside it rather than under it: the
 * two answer different questions and neither is a component of the other.
 *
 * The missing-file line is a sentence rather than a tile. It is a caveat about
 * rows already in the list, not a third quantity, and a "1" in a tile beside
 * two much larger figures reads as unimportant precisely when it is not.
 */
export function DocumentTotalsSummary({ documents }: { documents: readonly DocumentRow[] }) {
  const { t } = useTranslation();
  const totals = documentTotals(documents);

  return (
    <Block className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start gap-x-10 gap-y-3">
        <StatTile
          emphasis="hero"
          label={t('v3.documents.totals.stored')}
          value={formatBytes(totals.byteSize)}
        />
        {totals.extractions > 0 ? (
          <StatTile
            label={t('v3.documents.totals.invoicesFound')}
            value={<span className="tabular-nums">{totals.extractions}</span>}
          />
        ) : null}
      </div>
      {totals.fileMissing > 0 ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.documents.totals.fileMissing', { count: totals.fileMissing })}
        </p>
      ) : null}
    </Block>
  );
}
