import { Skeleton } from '@scani/ui/ui/skeleton';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { peekOpenState, peekPath } from '@scani/ui/v3/lib/peek';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import type { HomeChart } from '../../hooks/useHomeChart';
import { latestPnl, rebasePnlSeries } from '../../lib/home';
import { V3_ROUTES } from '../../lib/routes';
import { MaskedFigure, useSharedFigureVisibility } from './FigureVisibility';
import { formatChartDate } from './PortfolioChart';
import { ReturnsBlock } from './ReturnsBlock';

/**
 * What the Home chart's peek shows (SC-1692): details for the chart that is on,
 * over the period that is on, rather than the card again. Net worth and PnL
 * read one breakdown of the period; Returns reuses the returns card body on the
 * hero's own window, so it shares the hero's queries.
 */
export function HeroDetails({ chart, currency }: { chart: HomeChart; currency: string }) {
  if (chart.metric === 'returns') {
    return <ReturnsBlock heroWindow={chart.returns.request} variant="peek" />;
  }
  return <BreakdownDetails chart={chart} currency={currency} />;
}

function BreakdownDetails({ chart, currency }: { chart: HomeChart; currency: string }) {
  const { t } = useTranslation();
  const figure = useSharedFigureVisibility();
  const isPnl = chart.metric === 'pnl';
  const breakdown = trpc.portfolio.getPeriodBreakdown.useQuery(chart.range);
  // The hero's own query, so the split here is the one on the card.
  const pnlSeries = trpc.portfolio.getPnLSeries.useQuery(
    { ...chart.range, granularity: 'auto' },
    { enabled: isPnl }
  );
  const pnl = latestPnl(rebasePnlSeries(pnlSeries.data?.series ?? []));

  if (breakdown.isLoading) {
    return (
      <div className="space-y-3 p-4" aria-busy="true">
        <Skeleton aria-hidden="true" className="h-5 w-48" />
        <Skeleton aria-hidden="true" className="h-24 w-full" />
      </div>
    );
  }
  if (breakdown.isError || !breakdown.data) {
    return <p className="p-4 text-body text-muted-foreground">{t('v3.home.details.failed')}</p>;
  }

  const data = breakdown.data;
  const money = (value: string | number | null, signed = true) => (
    <MaskedFigure hidden={figure.hidden} onPeek={figure.onPeek}>
      <Numeric
        value={value}
        currency={currency}
        delta={signed}
        indicator={signed ? 'sign' : undefined}
      />
    </MaskedFigure>
  );
  const measured =
    data.startDate && data.endDate
      ? t('v3.home.details.measured', {
          from: formatChartDate(data.startDate, 'daily'),
          to: formatChartDate(data.endDate, 'daily'),
        })
      : null;
  const holdingLink = (holdingId: string) => ({
    href: peekPath(V3_ROUTES.holdings, holdingId),
    linkState: peekOpenState(V3_ROUTES.holdings),
  });

  return (
    <div className="space-y-6 pb-4">
      {measured ? <p className="px-4 text-caption text-muted-foreground">{measured}</p> : null}

      {isPnl ? (
        <Section title={t('v3.home.details.realizedVsUnrealized')}>
          <DataRowList className="border-t border-border">
            <DataRow label={t('v3.home.hero.realized')} value={pnl ? money(pnl.realized) : '—'} />
            <DataRow
              label={t('v3.home.hero.unrealized')}
              value={pnl ? money(pnl.unrealized) : '—'}
            />
          </DataRowList>
          <Note>{t('v3.home.details.pnlNote')}</Note>
        </Section>
      ) : (
        <Section title={t('v3.home.details.byAccountType')}>
          {data.byAccountType.length === 0 ? (
            <Note>{t('v3.home.details.empty')}</Note>
          ) : (
            <DataRowList className="border-t border-border">
              {data.byAccountType.map((part) => (
                <DataRow
                  key={part.code ?? 'other'}
                  label={part.name ?? t('v3.home.details.otherType')}
                  sublabel={money(part.end, false)}
                  value={money(part.change)}
                />
              ))}
            </DataRowList>
          )}
        </Section>
      )}

      {isPnl ? (
        <Section title={t('v3.home.details.topPnl')}>
          {data.topPnl.length === 0 ? (
            <Note>{t('v3.home.details.empty')}</Note>
          ) : (
            <DataRowList className="border-t border-border">
              {data.topPnl.map((entry) => (
                <DataRow
                  key={entry.holdingId}
                  label={entry.symbol ?? t('v3.home.details.unknownSymbol')}
                  sublabel={entry.accountName}
                  value={money(entry.total)}
                  {...holdingLink(entry.holdingId)}
                />
              ))}
            </DataRowList>
          )}
        </Section>
      ) : (
        <Section title={t('v3.home.details.topMovers')}>
          {data.topMovers.length === 0 ? (
            <Note>{t('v3.home.details.empty')}</Note>
          ) : (
            <DataRowList className="border-t border-border">
              {data.topMovers.map((mover) => (
                <DataRow
                  key={mover.holdingId}
                  label={mover.symbol ?? t('v3.home.details.unknownSymbol')}
                  sublabel={mover.accountName}
                  value={money(mover.change)}
                  {...holdingLink(mover.holdingId)}
                />
              ))}
            </DataRowList>
          )}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="px-4 text-label font-medium">{title}</h3>
      {children}
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="px-4 text-caption text-muted-foreground">{children}</p>;
}
