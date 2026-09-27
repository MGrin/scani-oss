import { formatDate } from '@scani/shared';
import { StatTile } from '@scani/ui/v3/components/charts/StatTile';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useTranslation } from 'react-i18next';
import type { ReturnsView } from '../../lib/returns';

export function ReturnsHeroTile({
  view,
  currency,
  periodSuffixKey,
}: {
  view: ReturnsView;
  currency: string;
  /** The period control's own suffix key, so the tile cannot name a different window. */
  periodSuffixKey: string;
}) {
  const { t } = useTranslation();
  const money = view.money;
  const rate = view.twr?.cumulative ?? null;

  return (
    <StatTile
      emphasis="hero"
      label={
        view.since
          ? t('v3.home.hero.returnsSince', { date: formatDate(view.since) })
          : t('v3.home.hero.returnsOverPeriod', { period: t(periodSuffixKey) })
      }
      value={<Numeric value={money?.change ?? null} currency={currency} delta indicator="sign" />}
      delta={
        rate === null ? (
          <span className="text-caption text-muted-foreground">
            {t('v3.home.hero.returnsNoRate')}
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-caption text-muted-foreground">
              {t('v3.home.returns.twr.label')}
            </span>
            <Numeric
              value={rate}
              format="percent"
              decimals={1}
              delta
              indicator="sign"
              className="text-caption"
            />
          </span>
        )
      }
    />
  );
}
