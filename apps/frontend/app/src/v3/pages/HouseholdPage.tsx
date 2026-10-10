import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { LoadingSpinner } from '@scani/ui/ui/loading';
import { Block } from '@scani/ui/v3/components/Block';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { PortfolioChart } from '../components/home/PortfolioChart';
import type { TrendPoint } from '../lib/home';
import { V3_ROUTES } from '../lib/routes';

const notInHousehold = (error: unknown) =>
  (error as { data?: { code?: string } } | null)?.data?.code === 'NOT_FOUND';

/**
 * v1's freshness rule in place of pushes: another member's change shows within a
 * minute. A non-member's answer will not change on retry, so it is never retried.
 */
const FRESHNESS = {
  refetchOnWindowFocus: true,
  refetchInterval: 60_000,
  retry: (failures: number, error: unknown) => !notInHousehold(error) && failures < 3,
} as const;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * What a household sees together (SC-1647): the combined net worth in the
 * household currency, its allocation, and every shared account with its owner.
 * Read-only: nothing here writes another member's data.
 */
export function HouseholdPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('v3.household.view.title'));
  const range = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - YEAR_MS), to };
  }, []);
  const view = trpc.household.view.useQuery({ dimension: 'token_type' }, FRESHNESS);
  const history = trpc.household.history.useQuery(range, FRESHNESS);

  const points = useMemo<TrendPoint[]>(() => {
    if (!history.data) return [];
    return [
      ...history.data.series.map((point) => ({ date: point.date, value: Number(point.value) })),
      // A day a rate was missing is a break in the line, never a dip to zero.
      ...history.data.unmeasuredDates.map((date) => ({ date, value: null })),
    ].sort((a, b) => a.date.localeCompare(b.date));
  }, [history.data]);

  const header = (
    <PageHeader
      title={t('v3.household.view.title')}
      description={t('v3.household.view.description')}
    />
  );
  if (!view.data) {
    return (
      <PageLayout>
        {header}
        {notInHousehold(view.error) ? (
          <p>
            {t('v3.household.view.none')}{' '}
            <Link to={V3_ROUTES.settings}>{t('v3.household.view.toSettings')}</Link>
          </p>
        ) : view.error ? (
          <p>{t('v3.household.view.unavailable')}</p>
        ) : (
          <LoadingSpinner />
        )}
      </PageLayout>
    );
  }

  const { baseCurrencySymbol: currency, accounts, allocation, trackedTwice } = view.data;
  const nameOf = new Map(accounts.map((account) => [account.accountId, account.name]));
  return (
    <PageLayout>
      {header}
      <Block className="flex flex-col gap-2 p-4">
        <Numeric value={view.data.total} currency={currency} className="text-display" />
        <p className="text-caption text-muted-foreground">
          {t('v3.household.view.currency', { currency })}
        </p>
        {points.length > 0 ? (
          <PortfolioChart
            metric="net-worth"
            netWorth={points}
            pnl={[]}
            currency={currency}
            granularity="daily"
            label={t('v3.household.view.chart')}
          />
        ) : null}
      </Block>

      {trackedTwice.map((pair) => (
        <p key={pair.accountIds.join(':')} role="note" className="text-caption">
          {t('v3.household.view.trackedTwice', { name: nameOf.get(pair.accountIds[0]) ?? '' })}
        </p>
      ))}

      <Block className="flex flex-col gap-2 p-4">
        <h2 className="text-title">{t('v3.household.view.allocation')}</h2>
        <ul className="flex flex-col gap-1">
          {allocation.map((item) => (
            <li key={item.id} className="flex justify-between gap-4">
              <span>{item.name}</span>
              <Numeric value={item.value} currency={currency} />
            </li>
          ))}
        </ul>
      </Block>

      <Block className="flex flex-col gap-2 p-4">
        <h2 className="text-title">{t('v3.household.view.accounts')}</h2>
        <ul className="flex flex-col gap-2">
          {accounts.map((account) => (
            <li key={account.accountId} className="flex justify-between gap-4">
              <span className="flex flex-col">
                <span>
                  {t('v3.household.view.accountOwner', {
                    name: account.name,
                    owner: account.ownedByViewer ? t('v3.household.view.you') : account.ownerName,
                  })}
                </span>
                <span className="text-caption text-muted-foreground">
                  {account.institutionName}
                </span>
              </span>
              <Numeric value={account.value} currency={currency} />
            </li>
          ))}
        </ul>
      </Block>
    </PageLayout>
  );
}
