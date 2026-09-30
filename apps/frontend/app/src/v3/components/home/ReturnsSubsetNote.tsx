import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useTranslation } from 'react-i18next';
import type { ReturnsSubsetView } from '../../lib/returns';

/**
 * Which holdings a return was taken over, when it was not all of them
 * (SC-1421). `brief` is the one line that sits under the figure, in the hero
 * and on the card (SC-1439); the card also names, at its foot, what was
 * left out, why, and what it was worth, and which holdings entered at their
 * statement's first day (SC-1427) and which tokens counted at zero (SC-1428).
 */
export function ReturnsSubsetNote({
  subset,
  currency,
  brief = false,
  coveredAbove = false,
  className,
}: {
  subset: ReturnsSubsetView;
  currency: string;
  brief?: boolean;
  /** The card already says what is covered, directly under its figure (SC-1439). */
  coveredAbove?: boolean;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  // Held before their statement starts, so their earlier gain is not in the
  // figure (SC-1427); never priced, so counted at zero (SC-1428). The whole
  // note when nothing was left out.
  const extras = [
    subset.enteredLate > 0
      ? t('v3.home.returns.enteredLate', {
          holdings: t('v3.membership.count.holding', { count: subset.enteredLate }),
        })
      : null,
    subset.unpricedAtZero > 0
      ? t('v3.home.returns.unpricedAtZero', { count: subset.unpricedAtZero })
      : null,
  ].filter((line): line is string => line !== null);
  if (subset.excluded.length === 0) return <span className={className}>{extras.join(' ')}</span>;

  const holdings = t('v3.membership.count.holding', { count: subset.measured });
  const covers =
    subset.valueShare === null
      ? t('v3.home.returns.subset', { included: subset.included, holdings })
      : t(
          subset.valueBase === 'netWorth'
            ? 'v3.home.returns.coversNetWorth'
            : 'v3.home.returns.coversValue',
          {
            share: new Intl.NumberFormat(i18n.language, {
              style: 'percent',
              maximumFractionDigits: subset.valueShare < 0.1 ? 1 : 0,
            }).format(subset.valueShare),
            included: subset.included,
            holdings,
          }
        );
  if (brief) return <span className={className}>{covers}</span>;

  const reasons = new Intl.ListFormat(i18n.language, { type: 'unit' }).format(
    subset.excluded.map(
      ({ reason, holdings }) => `${t(`v3.home.returns.eligibility.${reason}`)} (${holdings})`
    )
  );
  return (
    <p className={className}>
      {coveredAbove ? null : `${covers} `}
      {t('v3.home.returns.leftOut')} <Numeric value={subset.excludedValue} currency={currency} /> ·{' '}
      {reasons}
      {extras.map((line) => (
        <span key={line} className="mt-1 block">
          {line}
        </span>
      ))}
    </p>
  );
}
