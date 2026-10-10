import { formatDate } from '@scani/shared';
import { ChartFrame } from '@scani/ui/v3/components/charts/ChartFrame';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { chartSlotColor } from '@scani/ui/v3/lib/chart';
import { useTranslation } from 'react-i18next';
import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { trpc } from '@/lib/trpc';
import { calendarDay, INCOME_GROUPS, type IncomeView, toIncomeView } from '../../lib/income';
import type { ReturnsWindowRequest } from '../../lib/returns';
import { HomeCard, type HomeCardVariant, RowsSkeleton } from './HomeCard';

const AXIS_TICK = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' };

/** One colour per group, shared by its bar and the swatch that names it. */
function groupColor(group: (typeof INCOME_GROUPS)[number]): string {
  return chartSlotColor(INCOME_GROUPS.indexOf(group) + 1);
}

/**
 * Income RECEIVED over the returns card's window (SC-1644): dividends,
 * interest, staking and rewards, with the tax withheld beside the gross.
 *
 * Not the Money page's expected income. That one is a forecast and this is a
 * record, and the two are never drawn as one figure (V3-47). It asks its own
 * procedure, which reads ledger rows rather than the rollup, so it waits on
 * neither the returns engine nor its probe.
 */
export function IncomeBlock({
  heroWindow = null,
  variant = 'card',
}: {
  heroWindow?: ReturnsWindowRequest | null;
  variant?: HomeCardVariant;
}) {
  const { t } = useTranslation();
  const { symbol } = useBaseCurrency();
  const query = trpc.portfolio.getIncome.useQuery({ window: heroWindow ?? { kind: '1y' } });
  const view = toIncomeView(query.data?.income);
  return (
    <HomeCard
      title={t('v3.home.income.title')}
      subject={t('v3.home.income.loadingLabel')}
      queries={[query]}
      absent={!view}
      variant={variant}
      peekId="income"
      tile={() => ({
        figure: (
          <Numeric
            value={(view?.totals ?? []).reduce((sum, total) => sum + total.net, 0)}
            currency={symbol}
            compact
          />
        ),
        caption: (view?.totals ?? [])
          .map((total) => t(`v3.home.income.group.${total.group}`))
          .join(' · '),
      })}
      skeleton={<RowsSkeleton />}
    >
      {() => (view ? <IncomeCard view={view} currency={symbol} /> : null)}
    </HomeCard>
  );
}

export function IncomeCard({ view, currency }: { view: IncomeView; currency: string }) {
  const { t } = useTranslation();
  return (
    <>
      <p className="px-4 pb-2 text-caption text-muted-foreground">
        {t('v3.home.income.window', {
          from: formatDate(calendarDay(view.window.from)),
          to: formatDate(calendarDay(view.window.to)),
        })}
      </p>
      {view.months.length > 0 ? (
        <div className="px-4 pb-3">
          <ChartFrame label={t('v3.home.income.chartLabel')} height={140}>
            <BarChart data={view.months} margin={{ top: 4, bottom: 0, left: 0, right: 0 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="month" tick={AXIS_TICK} tickLine={false} axisLine={false} />
              {INCOME_GROUPS.map((group) => (
                <Bar
                  key={group}
                  dataKey={(point: IncomeView['months'][number]) => point.segments[group] ?? 0}
                  name={t(`v3.home.income.group.${group}`)}
                  stackId="income"
                  fill={groupColor(group)}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ChartFrame>
        </div>
      ) : null}
      <dl className="flex flex-col gap-2 px-4 pb-3">
        {view.totals.map((total) => (
          <div key={total.group} className="flex flex-col gap-0.5">
            <dt className="flex items-center gap-2 text-body font-medium">
              <span
                aria-hidden="true"
                data-income-swatch={total.group}
                className="size-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: groupColor(total.group) }}
              />
              {t(`v3.home.income.group.${total.group}`)}
            </dt>
            <dd className="flex flex-wrap gap-x-4 text-caption text-muted-foreground">
              <span>
                {t('v3.home.income.gross')} <Numeric value={total.gross} currency={currency} />
              </span>
              {total.withheld > 0 ? (
                <span>
                  {t('v3.home.income.withheld')}{' '}
                  <Numeric value={total.withheld} currency={currency} />
                </span>
              ) : null}
              <span>
                {t('v3.home.income.net')} <Numeric value={total.net} currency={currency} />
              </span>
            </dd>
          </div>
        ))}
      </dl>
      {view.securities.length > 0 ? (
        <div className="border-t border-border px-4 py-3">
          <h3 className="pb-2 text-caption font-medium text-muted-foreground">
            {t('v3.home.income.bySecurity')}
          </h3>
          <ul className="flex flex-col gap-1">
            {view.securities.map((source) => (
              <li key={source.label} className="flex items-baseline justify-between gap-3">
                <span className="text-body">
                  {source.label}{' '}
                  <span className="text-caption text-muted-foreground">
                    {t('v3.home.income.payments', { count: source.payments })}
                  </span>
                </span>
                <Numeric value={source.net} currency={currency} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {view.unpriced > 0 ? (
        <p className="px-4 pb-3 text-caption text-muted-foreground">
          {t('v3.home.income.unpriced', { count: view.unpriced })}
        </p>
      ) : null}
    </>
  );
}
