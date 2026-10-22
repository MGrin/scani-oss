import { formatDate } from '@scani/shared';
import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { LoadingSpinner } from '@scani/ui/ui/loading';
import { Block } from '@scani/ui/v3/components/Block';
import { StatTile } from '@scani/ui/v3/components/charts/StatTile';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import type { V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { Mail, Wallet } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { AllocationBar } from '../components/charts/AllocationBar';
import { InstitutionMark } from '../components/entities/InstitutionMark';
import { PortfolioChart } from '../components/home/PortfolioChart';
import type { TrendPoint } from '../lib/home';
import { type HouseholdAccount, type HouseholdMember, memberShares } from '../lib/household-view';
import { settingsAreaPath } from '../lib/settings-areas';

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
 * What a household sees together (SC-1647), laid out like Accounts (SC-1712):
 * the combined value and its allocation in one card, who is in the household
 * and what each shares, then the shared accounts as a searchable list.
 * Read-only: membership is managed in Settings.
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
  const mine = trpc.household.mine.useQuery(undefined, FRESHNESS);

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
      description={mine.data?.household?.name ?? t('v3.household.view.description')}
    />
  );
  if (!view.data) {
    return (
      <PageLayout measure="wide">
        {header}
        {notInHousehold(view.error) ? (
          <p>
            {t('v3.household.view.none')}{' '}
            <Link to={settingsAreaPath('data')}>{t('v3.household.view.toSettings')}</Link>
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
    <PageLayout measure="wide">
      {header}
      <Block className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1">
          <StatTile
            emphasis="hero"
            label={t('v3.entities.value')}
            value={<Numeric value={view.data.total} currency={currency} />}
          />
          <p className="text-caption text-muted-foreground">
            {t('v3.household.view.currency', { currency })}
          </p>
        </div>
        {points.some((point) => point.value !== null) ? (
          <PortfolioChart
            metric="net-worth"
            netWorth={points}
            pnl={[]}
            currency={currency}
            granularity="daily"
            label={t('v3.household.view.chart')}
          />
        ) : null}
        <AllocationBar
          items={allocation.map((item) => ({
            key: item.id,
            label: item.name,
            value: Number(item.value),
          }))}
          currency={currency}
          label={t('v3.household.view.allocation')}
        />
      </Block>

      {trackedTwice.map((pair) => (
        <p key={pair.accountIds.join(':')} role="note" className="text-caption">
          {t('v3.household.view.trackedTwice', { name: nameOf.get(pair.accountIds[0]) ?? '' })}
        </p>
      ))}

      <Members
        members={mine.data?.members ?? []}
        invites={mine.data?.invites ?? []}
        accounts={accounts}
        viewerId={mine.data?.viewerId ?? null}
        currency={currency}
      />

      <section className="flex flex-col gap-3" aria-labelledby="household-accounts-heading">
        <h2 id="household-accounts-heading" className="text-title">
          {t('v3.household.view.accounts')}
        </h2>
        <SharedAccounts
          accounts={accounts}
          members={mine.data?.members ?? []}
          currency={currency}
        />
      </section>
    </PageLayout>
  );
}

/** Who is in the household, what each shares, and who has not answered yet. */
function Members({
  members,
  invites,
  accounts,
  viewerId,
  currency,
}: {
  members: readonly HouseholdMember[];
  invites: ReadonlyArray<{ id: string; email: string; expiresAt: string | Date }>;
  accounts: readonly HouseholdAccount[];
  viewerId: string | null;
  currency: string;
}) {
  const { t } = useTranslation();
  if (members.length === 0) return null;
  const shares = memberShares(members, accounts);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="household-members-heading">
      {/* The section's action sits beside its heading (UI standard rule 1). */}
      <div className="flex items-center justify-between gap-3">
        <h2 id="household-members-heading" className="text-title">
          {t('v3.household.view.members')}
        </h2>
        <Button asChild variant="outline" size="sm">
          <Link to={settingsAreaPath('data')}>{t('v3.household.view.manage')}</Link>
        </Button>
      </div>
      <Block>
        <DataRowList>
          {shares.map((member) => {
            const role =
              member.role === 'admin'
                ? t('v3.settings.household.roleAdmin')
                : t('v3.settings.household.roleMember');
            return (
              <li key={member.userId}>
                <DataRow
                  leading={<InstitutionMark name={member.name} size="size-5" />}
                  label={
                    member.userId === viewerId
                      ? t('v3.household.view.memberYou', { name: member.name })
                      : member.name
                  }
                  sublabel={
                    member.count === 0
                      ? t('v3.household.view.memberSharesNothing', { role })
                      : t('v3.household.view.memberShares', { count: member.count, role })
                  }
                  value={<Numeric value={member.value} currency={currency} />}
                />
              </li>
            );
          })}
          {invites.map((invite) => (
            <li key={invite.id}>
              <DataRow
                leading={<Mail className="size-4 text-muted-foreground" aria-hidden="true" />}
                label={invite.email}
                sublabel={t('v3.settings.household.expires', {
                  date: formatDate(invite.expiresAt),
                })}
                value={null}
                delta={
                  <Badge variant="outline" className="border-border-strong">
                    {t('v3.household.view.invited')}
                  </Badge>
                }
              />
            </li>
          ))}
        </DataRowList>
      </Block>
    </section>
  );
}

/** The shared accounts, searchable and refinable like Accounts. */
function SharedAccounts({
  accounts,
  members,
  currency,
}: {
  accounts: HouseholdAccount[];
  members: readonly HouseholdMember[];
  currency: string;
}) {
  const { t } = useTranslation();
  const ownerLabel = (account: HouseholdAccount) =>
    account.ownedByViewer ? t('v3.household.view.you') : account.ownerName;
  const institutions = [
    ...new Map(accounts.map((account) => [account.institutionId, account.institutionName])),
  ];

  const config: V3DataViewConfig<HouseholdAccount> = {
    pageKey: 'household-accounts',
    data: accounts,
    nounKey: 'ui.dataView.noun.accounts',
    searchPlaceholderKey: 'ui.dataView.accounts.config.search',
    searchFn: (account, query) =>
      [account.name, account.institutionName, account.ownerName].some((text) =>
        text.toLowerCase().includes(query)
      ),
    filterDefs: [
      {
        key: 'member',
        labelKey: 'ui.dataView.householdAccounts.filter.member',
        options: members.map((member) => ({ value: member.userId, label: member.name })),
        fn: (account: HouseholdAccount, value) => account.ownerId === value,
      },
      {
        key: 'institution',
        labelKey: 'ui.dataView.accounts.filter.institution',
        options: institutions.map(([value, label]) => ({ value, label })),
        fn: (account: HouseholdAccount, value) => account.institutionId === value,
      },
    ],
    sortDefs: [
      { key: 'value', labelKey: 'ui.dataView.accounts.sort.value' },
      { key: 'name', labelKey: 'ui.dataView.accounts.sort.name' },
    ],
    sortFn: (a, b, field, direction) => {
      const sign = direction === 'asc' ? 1 : -1;
      return field === 'name'
        ? sign * a.name.localeCompare(b.name)
        : sign * (Number(a.value) - Number(b.value));
    },
    defaultSort: { field: 'value', direction: 'desc' },
    groupByDefs: [
      {
        key: 'member',
        labelKey: 'ui.dataView.householdAccounts.filter.member',
        fn: ownerLabel,
      },
    ],
    renderRow: (account) => ({
      leading: (
        <InstitutionMark
          name={account.institutionName}
          institution={{ id: account.institutionId, website: account.institutionWebsite }}
          size="size-5"
        />
      ),
      label: account.name,
      sublabel: t('v3.household.view.accountSublabel', {
        owner: ownerLabel(account),
        institution: account.institutionName,
      }),
      value: <Numeric value={account.value} currency={currency} />,
      ariaLabel: [account.name, ownerLabel(account), account.institutionName].join(', '),
    }),
    columns: [
      {
        key: 'name',
        headerKey: 'ui.dataView.accounts.col.account',
        sortable: true,
        render: (account) => <span className="truncate text-label">{account.name}</span>,
      },
      {
        key: 'member',
        headerKey: 'ui.dataView.householdAccounts.col.member',
        render: (account) => <span className="truncate">{ownerLabel(account)}</span>,
      },
      {
        key: 'institution',
        headerKey: 'ui.dataView.accounts.col.institution',
        render: (account) => (
          <span className="flex min-w-0 items-center gap-2">
            <InstitutionMark
              name={account.institutionName}
              institution={{ id: account.institutionId, website: account.institutionWebsite }}
              size="size-4"
            />
            <span className="truncate">{account.institutionName}</span>
          </span>
        ),
      },
      {
        key: 'value',
        headerKey: 'ui.dataView.accounts.col.value',
        sortable: true,
        numeric: true,
        render: (account) => <Numeric value={account.value} currency={currency} />,
      },
    ],
    empty: {
      icon: Wallet,
      titleKey: 'ui.dataView.householdAccounts.empty.title',
      descriptionKey: 'ui.dataView.householdAccounts.empty.description',
      action: (
        <Button asChild>
          <Link to={settingsAreaPath('data')}>{t('v3.household.view.shareAccounts')}</Link>
        </Button>
      ),
    },
  };

  return <V3DataView config={config} getId={(account) => account.accountId} />;
}
