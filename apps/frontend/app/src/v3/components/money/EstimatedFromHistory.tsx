import { Numeric } from '@scani/ui/v3/components/Numeric';
import { Trans, useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatProjectionMonth } from './ProjectionChart';

/**
 * The THIRD register: a figure that is a claim resting on a further claim
 * (SC-625).
 *
 * The surface already had two. A measured figure is a `<StatTile>`, solid. A
 * projection is a `<ProjectedTile>` — dashed rule, the word "Projected", never
 * tinted, because a forecast has no measured direction. A payment priced from
 * its own settled history is neither: the projection is a claim about the
 * future *and* the amount it is built on was never declared by anybody.
 *
 * ## Why this is not a louder mark
 *
 * The obvious third register is more alarm — a colour, a warning tint, a
 * heavier border. That would be wrong twice. It would break the rule
 * `<ProjectedTile>` is built around (a projected figure takes no tint, because
 * tinting a guess is the interface agreeing with it), and it would rank the
 * two claims by volume when what separates them is not severity.
 *
 * **What separates them is PROVENANCE, so that is the mark.** A fixed bill has
 * nothing to cite; a declared estimate has nothing to cite; this figure names
 * the settlement it came from, and no other figure on the surface can. So the
 * distinguishing property is one that only the estimated figure *can* have,
 * rather than a decoration applied to it — which is why it cannot be confused
 * with a fixed bill in the same series even by a reader who has never learnt
 * what the dashes mean.
 *
 * It also degrades correctly. Strip the badge, strip the stylesheet, read the
 * page as plain text: "Estimated from Feb 2026 · €84.20" is still a sentence
 * saying this number is a different month's. A treatment that lives only in
 * the border cannot survive that, and SC-71's type floor and SC-461's dashes
 * are both things a stylesheet owns.
 *
 * The badge borrows `<ProjectedTile>`'s dashed outline deliberately: "dashed
 * means this is a claim" is a vocabulary the reader learns once, on one
 * screen, and a second unrelated mark would spend that. Only the word differs.
 */
interface EstimatedFromHistoryProps {
  /**
   * The settled figure, cited only where it is NOT already on screen beside
   * this mark.
   *
   * A row whose value slot shows the estimated amount does not want it printed
   * twice a line apart — two identical figures read as two facts, and a reader
   * comparing them learns nothing. So the row passes the month alone and the
   * standalone contexts pass both. It is a question about what is adjacent,
   * not a style preference, which is why it is a prop rather than a variant.
   */
  amount?: string;
  currency?: string;
  /** `YYYY-MM-DD` of the settlement it came from. */
  sourceDueDate: string;
  className?: string;
}

export function EstimatedFromHistory({
  amount,
  currency,
  sourceDueDate,
  className,
}: EstimatedFromHistoryProps) {
  const { t } = useTranslation();
  const month = formatProjectionMonth(sourceDueDate.slice(0, 7));

  return (
    <span className={cn('flex flex-wrap items-center gap-2', className)}>
      {/* `text-caption` (13px) is v3's type floor and a badge is not exempt
          (SC-71 6.1); a `<span>` rather than the shared `<Badge>` because every
          `<Badge>` variant is a filled solid, which is the one thing a mark
          meaning "not measured" must not be. Same reasoning, same shape as
          `<ProjectedTile>`'s. */}
      <span className="rounded border border-dashed border-muted-foreground/70 px-1.5 text-caption uppercase leading-tight tracking-wide text-muted-foreground">
        {t('v3.money.forecast.estimatedMark')}
      </span>
      <span className="text-caption text-muted-foreground">
        {amount !== undefined && currency !== undefined ? (
          <Trans
            i18nKey="v3.money.forecast.estimatedFromAmount"
            values={{ month }}
            components={{ value: <Numeric value={amount} currency={currency} /> }}
          />
        ) : (
          t('v3.money.forecast.estimatedFrom', { month })
        )}
      </span>
    </span>
  );
}
