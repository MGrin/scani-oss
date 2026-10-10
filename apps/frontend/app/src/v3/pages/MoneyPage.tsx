import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Button } from '@scani/ui/ui/button';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { DataViewToolbar } from '@scani/ui/v3/components/data-view/DataViewToolbar';
import { RefineSheet } from '@scani/ui/v3/components/data-view/RefineSheet';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { useDataView } from '@scani/ui/v3/hooks/useDataView';
import { useDataViewUrlState } from '@scani/ui/v3/hooks/useDataViewUrlState';
import { useSheetRoute } from '@scani/ui/v3/hooks/useSheetRoute';
import { resolveActiveFilters, type V3FilterDef } from '@scani/ui/v3/lib/data-view';
import { readDataViewUrl } from '@scani/ui/v3/lib/data-view-url';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { refineSheet } from '@scani/ui/v3/lib/sheet';
import { Plus, ReceiptText } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { type BaseCurrencyRates, useBaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import { type RouterOutputs, trpc } from '@/lib/trpc';
import { CreateVendorSheet } from '../components/money/CreateVendorSheet';
import type { GroupTag } from '../components/money/GroupTags';
import { PaymentSheetLink } from '../components/money/PaymentSheetLink';
import { RecurringList } from '../components/money/RecurringList';
import { RecurringSuggestions } from '../components/money/RecurringSuggestions';
import { SettledFeed } from '../components/money/SettledFeed';
import { UpcomingFeed } from '../components/money/UpcomingFeed';
import { VendorList } from '../components/money/VendorList';
import {
  billPeriodDays,
  MONEY_SEGMENTS,
  type MoneySegment,
  moneySegmentPath,
  resolveMoneySegment,
  settledWithin,
  upcomingBills,
} from '../lib/money';
import {
  type HistoryEstimate,
  historyEstimatesByPaymentId,
  todayDateString,
} from '../lib/paymentTotals';
import { PAYMENT_SHEET, V3_ROUTES } from '../lib/routes';

type Occurrence = RouterOutputs['payments']['upcoming'][number];

/** `pageKey` with no `:`, so each filter's URL parameter is its own name:
 *  `/payments?vendor=<id>` and `?group=<id>`, the links a payee's and a group's
 *  pages emit, seed the list directly. */
const BILLS_PAGE_KEY = 'bills';

const STATUS_VALUES = ['matched', 'missed', 'skipped', 'all'] as const;
type StatusFilter = '' | (typeof STATUS_VALUES)[number];

function isStatusFilter(value: string | undefined): value is StatusFilter {
  return value === '' || STATUS_VALUES.includes(value as (typeof STATUS_VALUES)[number]);
}

export function MoneyPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('v3.money.page.title'));
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const segment = resolveMoneySegment(pathname);
  const [creatingVendor, setCreatingVendor] = useState(false);

  const payments = trpc.payments.list.useQuery();
  const vendors = trpc.vendors.list.useQuery();
  const tokens = trpc.tokens.getAll.useQuery();
  const groups = trpc.groups.getAll.useQuery(undefined, { enabled: segment !== 'vendors' });
  const assignments = trpc.payments.groupAssignments.useQuery(undefined, {
    enabled: segment !== 'vendors',
  });
  const vendorSpend = trpc.vendors.spend.useQuery(undefined, { enabled: segment === 'vendors' });
  const scheduled = trpc.payments.scheduled.useQuery();
  const historyEstimates = useMemo(
    () => historyEstimatesByPaymentId(scheduled.data?.estimatedFromHistory ?? []),
    [scheduled.data]
  );
  const vendorNameById = useMemo(
    () => new Map((vendors.data ?? []).map((entry) => [entry.id, entry.displayName])),
    [vendors.data]
  );
  const tokenSymbolById = useMemo(
    () => new Map((tokens.data ?? []).map((entry) => [entry.id, entry.symbol])),
    [tokens.data]
  );
  const rates = useBaseCurrencyRates(
    (payments.data ?? []).map((payment) => payment.currencyTokenId)
  );
  const groupOptions = useMemo(
    () => (groups.data ?? []).map((entry) => ({ value: entry.id, label: entry.name })),
    [groups.data]
  );
  const groupById = useMemo(
    () =>
      new Map(
        (groups.data ?? []).map((entry) => [entry.id, { name: entry.name, color: entry.color }])
      ),
    [groups.data]
  );

  const changeSegment = (next: string) => {
    setCreatingVendor(false);
    navigate(moneySegmentPath(next as MoneySegment));
  };

  return (
    <PageLayout measure="wide">
      <PageHeader
        title={t('v3.money.page.title')}
        action={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to={V3_ROUTES.transactions}>
                <ReceiptText className="me-1.5 h-4 w-4" aria-hidden="true" />
                {t('v3.transactions.title')}
              </Link>
            </Button>
            {segment === 'vendors' ? (
              <Button onClick={() => setCreatingVendor(true)}>
                <Plus className="me-1.5 h-4 w-4" aria-hidden="true" />
                {t('v3.money.page.newVendor')}
              </Button>
            ) : (
              <Button asChild>
                <PaymentSheetLink sheet={PAYMENT_SHEET.create}>
                  <Plus className="me-1.5 h-4 w-4" aria-hidden="true" />
                  {t('v3.money.page.addPayment')}
                </PaymentSheetLink>
              </Button>
            )}
          </div>
        }
      />

      <Segmented
        value={segment}
        onValueChange={changeSegment}
        aria-label={t('v3.money.page.viewSwitcher')}
      >
        {MONEY_SEGMENTS.map((entry) => (
          <SegmentedItem key={entry.key} value={entry.key}>
            {t(entry.labelKey)}
          </SegmentedItem>
        ))}
      </Segmented>

      {segment === 'upcoming' ? (
        <BillsList
          paymentCount={payments.data?.length ?? 0}
          vendorNameById={vendorNameById}
          tokenSymbolById={tokenSymbolById}
          rates={rates}
          historyEstimates={historyEstimates}
          groupOptions={groupOptions}
          occurrenceGroups={assignments.data?.occurrences ?? {}}
          groupById={groupById}
        />
      ) : null}

      {segment === 'recurring' ? (
        <>
          <RecurringSuggestions tokenSymbolById={tokenSymbolById} />
          <RecurringList
            payments={payments.data ?? []}
            vendorNameById={vendorNameById}
            tokenSymbolById={tokenSymbolById}
            rates={rates}
            query={mergeQueries(payments, vendors, tokens, assignments)}
            historyEstimates={historyEstimates}
            groupOptions={groupOptions}
            groupIdsByPayment={assignments.data?.payments}
            groupById={groupById}
          />
        </>
      ) : null}

      {segment === 'vendors' ? (
        <VendorList
          vendors={vendors.data ?? []}
          payments={payments.data ?? []}
          spend={vendorSpend.data ?? null}
          tokenSymbolById={tokenSymbolById}
          rates={rates}
          query={mergeQueries(vendors, payments, tokens, vendorSpend)}
          historyEstimates={historyEstimates}
          onCreatingChange={setCreatingVendor}
        />
      ) : null}
      <CreateVendorSheet open={creatingVendor} onOpenChange={setCreatingVendor} />
    </PageLayout>
  );
}

interface BillsListProps {
  paymentCount: number;
  vendorNameById: Map<string, string>;
  tokenSymbolById: Map<string, string>;
  rates: BaseCurrencyRates;
  historyEstimates: ReadonlyMap<string, HistoryEstimate>;
  groupOptions: { value: string; label: string }[];
  occurrenceGroups: Readonly<Record<string, readonly string[]>>;
  groupById: ReadonlyMap<string, GroupTag>;
}

/**
 * The Bills list (SC-1405): one toolbar, the app's own, above a list that
 * needs no settings to read. Search finds a payee; everything else is behind
 * Refine, and the two filters that change what the list IS, status and
 * period, default to "what is due in the next 30 days" without showing a chip.
 */
function BillsList({
  paymentCount,
  vendorNameById,
  tokenSymbolById,
  rates,
  historyEstimates,
  groupOptions,
  occurrenceGroups,
  groupById,
}: BillsListProps) {
  const { t } = useTranslation();
  const location = useLocation();

  // Status decides what the server returns, so it is read from the URL before
  // the query is issued rather than from the list state the query feeds.
  const statusParam = readDataViewUrl(location.search, BILLS_PAGE_KEY, [
    { key: 'status', options: [] },
  ]).filters.status;
  const status: StatusFilter = isStatusFilter(statusParam) ? statusParam : '';
  const upcoming = trpc.payments.upcoming.useQuery({
    days: 365,
    status: status === '' ? 'scheduled' : status,
  });

  const vendorOptions = useMemo(
    () =>
      [...vendorNameById.entries()]
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [vendorNameById]
  );

  const settledView = status !== '';
  const filterDefs = useMemo<V3FilterDef[]>(
    () => [
      {
        key: 'status',
        labelKey: 'ui.dataView.bills.filter.status',
        anyLabelKey: 'ui.dataView.bills.status.upcoming',
        options: STATUS_VALUES.map((value) => ({
          value,
          labelKey: `ui.dataView.bills.status.${value}` as const,
        })),
      },
      {
        key: 'period',
        labelKey: 'ui.dataView.bills.filter.period',
        anyLabelKey: settledView
          ? 'ui.dataView.bills.period.last30'
          : 'ui.dataView.bills.period.next30',
        options: settledView
          ? [
              { value: '90', labelKey: 'ui.dataView.bills.period.last90' },
              { value: '365', labelKey: 'ui.dataView.bills.period.last365' },
            ]
          : [
              { value: '90', labelKey: 'ui.dataView.bills.period.next90' },
              { value: '365', labelKey: 'ui.dataView.bills.period.next365' },
            ],
      },
      ...(groupOptions.length > 0
        ? [
            {
              key: 'group',
              labelKey: 'ui.dataView.bills.filter.group' as const,
              options: groupOptions,
              fn: (row: Occurrence, value: string) =>
                (occurrenceGroups[row.id] ?? []).includes(value),
            },
          ]
        : []),
      {
        key: 'vendor',
        labelKey: 'ui.dataView.bills.filter.payee',
        options: vendorOptions,
        fn: (row: Occurrence, value: string) => row.payment.vendorId === value,
      },
    ],
    [settledView, groupOptions, occurrenceGroups, vendorOptions]
  );

  // Seeded on the first render only, the way `V3DataView` seeds: later URL
  // changes reach the list through `useDataViewUrlState`.
  const seeded = useRef<Record<string, string> | null>(null);
  if (seeded.current === null) {
    seeded.current = readDataViewUrl(location.search, BILLS_PAGE_KEY, filterDefs).filters;
  }
  const dv = useDataView(
    {
      pageKey: `v3:${BILLS_PAGE_KEY}`,
      data: upcoming.data ?? [],
      filterDefs,
      defaultFilters: seeded.current,
      searchFn: (row: Occurrence, query: string) =>
        (vendorNameById.get(row.payment.vendorId) ?? '').toLowerCase().includes(query),
    },
    (row) => row.id
  );
  const url = useDataViewUrlState(BILLS_PAGE_KEY, filterDefs, dv);
  const refine = useSheetRoute(refineSheet(BILLS_PAGE_KEY));
  const [search, setSearch] = useState(dv.searchTerm);
  const { setSearchTerm } = dv;
  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(search), 150);
    return () => clearTimeout(timer);
  }, [search, setSearchTerm]);

  const activeFilters = resolveActiveFilters(dv.filters, filterDefs);
  const days = billPeriodDays(dv.filters.period);
  const today = todayDateString();
  // The same queries the page issued; tRPC shares them, so this costs nothing
  // and lets the list's loading and error state cover every input it reads.
  const vendors = trpc.vendors.list.useQuery();
  const tokens = trpc.tokens.getAll.useQuery();
  const assignments = trpc.payments.groupAssignments.useQuery();
  const query = mergeQueries(upcoming, vendors, tokens, assignments);

  const settled = useMemo(
    () => (settledView ? settledWithin(dv.filteredData, today, days) : []),
    [settledView, dv.filteredData, today, days]
  );

  const toolbar = (
    <div className="sticky top-0 z-10 flex flex-col gap-2 bg-background pb-2 pt-1">
      <DataViewToolbar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder={t('ui.dataView.bills.config.searchByPayee')}
        searchLabel={t('ui.dataView.bills.config.searchByPayee')}
        onRefine={refine.open}
        activeFilters={activeFilters}
        onRemoveFilter={(key) => url.setFilter(key, '')}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {settledView ? toolbar : null}
      {settledView ? (
        <SettledFeed
          occurrences={settled}
          vendorNameById={vendorNameById}
          tokenSymbolById={tokenSymbolById}
          rates={rates}
          query={query}
          historyEstimates={historyEstimates}
          occurrenceGroups={occurrenceGroups}
          groupById={groupById}
        />
      ) : (
        <UpcomingFeed
          toolbar={toolbar}
          occurrences={dv.filteredData}
          paymentCount={paymentCount}
          vendorNameById={vendorNameById}
          tokenSymbolById={tokenSymbolById}
          rates={rates}
          query={query}
          historyEstimates={historyEstimates}
          horizonDays={days}
          occurrenceGroups={occurrenceGroups}
          groupById={groupById}
        />
      )}

      <RefineSheet
        open={refine.isOpen}
        onOpenChange={refine.setOpen}
        nounKey="ui.dataView.noun.payments"
        filters={dv.filters}
        filterDefs={filterDefs}
        onSetFilter={url.setFilter}
        sortField={dv.sortField}
        sortDirection={dv.sortDirection}
        onSetSort={dv.setSort}
        groupBy={dv.groupBy}
        onSetGroupBy={url.setGroupBy}
        hasActiveFilters={dv.hasActiveFilters}
        onClearFilters={() => {
          setSearch('');
          url.clearFilters();
        }}
        filteredCount={
          settledView ? settled.length : upcomingBills(dv.filteredData, today, days).length
        }
      />
    </div>
  );
}
