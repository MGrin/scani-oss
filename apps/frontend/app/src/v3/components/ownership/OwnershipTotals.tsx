import { Block } from '@scani/ui/v3/components/Block';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useTranslation } from 'react-i18next';

/**
 * What each set of books is worth, and what they come to together (SC-463).
 *
 * **Why this renders the combined figure beside the parts rather than on
 * another screen.** The invariant the whole feature turns on is
 * `sum(entities) + unassigned === totalValue`, and the two ways to get it
 * wrong — per-entity totals that double-count, a combined view that
 * under-reports — are both silent. Putting the parts and the whole in one
 * block is what makes a wrong one visible to the person reading it, because
 * the arithmetic is on the screen and adds up or does not.
 *
 * The unassigned row is ALWAYS rendered, even at zero. It is the bucket
 * holding every account nobody has classified, and hiding it when empty would
 * mean the one moment it stops being empty — an account arriving from a new
 * import, outside both boundaries — is the moment the row appears without
 * anyone looking for it.
 *
 * **Directory note.** This lives under `components/ownership/` rather than
 * `components/entities/`, which already exists and means something else: it
 * holds `AccountsList`, `InstitutionsList` and an `EntityValueSummary` about
 * the value of a RECORD. An ownership boundary is a different noun that
 * happens to share the word.
 *
 * Not tax output — SC-90 stays parked.
 */

export interface OwnershipBucket {
  /** An entity id, or the literal `'unassigned'`. */
  entityId: string;
  name: string;
  value: string;
  holdingsCounted: number;
  unpricedSymbols: string[];
}

interface OwnershipTotalsProps {
  buckets: OwnershipBucket[];
  /** The combined figure, straight from the server — never re-added here. */
  totalValue: string;
  baseCurrency: string;
}

export function OwnershipTotals({ buckets, totalValue, baseCurrency }: OwnershipTotalsProps) {
  const { t } = useTranslation();

  return (
    <Block className="flex flex-col p-4" data-testid="ownership-totals">
      <ul className="flex flex-col divide-y divide-border">
        {buckets.map((bucket) => (
          <li
            key={bucket.entityId}
            data-testid={`ownership-bucket-${bucket.entityId}`}
            className="flex items-baseline justify-between gap-4 py-2.5"
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-label">{bucket.name}</span>
              <span className="text-caption text-muted-foreground">
                {t('v3.ownership.holdingsCounted', { count: bucket.holdingsCounted })}
                {bucket.unpricedSymbols.length > 0
                  ? ` · ${t('v3.ownership.unpriced', {
                      symbols: bucket.unpricedSymbols.join(', '),
                    })}`
                  : ''}
              </span>
            </div>
            <Numeric
              className="text-label"
              data-testid={`ownership-value-${bucket.entityId}`}
              value={Number(bucket.value)}
              currency={baseCurrency}
            />
          </li>
        ))}
      </ul>

      {/*
        The combined figure is `totalValue` as the server sent it, NOT a sum of
        the rows above. Re-adding them here would make this a second derivation
        of net worth that could drift from the home screen's — the SC-385
        failure — and would also make the block self-consistent by
        construction, so a real disagreement between the parts and the whole
        could never show up on the one screen built to reveal it.
      */}
      <div className="mt-1 flex items-baseline justify-between gap-4 border-t-2 border-border pt-3">
        <span className="text-label font-medium">{t('v3.ownership.combined')}</span>
        <Numeric
          className="text-display"
          data-testid="ownership-value-combined"
          value={Number(totalValue)}
          currency={baseCurrency}
        />
      </div>
    </Block>
  );
}
