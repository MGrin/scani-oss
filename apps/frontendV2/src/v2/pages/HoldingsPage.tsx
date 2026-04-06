import type { HoldingWithDetails } from '@scani/shared';
import { PieChart } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { getFaviconUrl } from '@/lib/icons';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { DataView as DataViewComponent } from '../components/data-view/DataView';
import type { ColumnDef } from '../components/data-view/DataViewTable';
import { HoldingBulkActions } from '../components/holdings/HoldingBulkActions';
import { HoldingCard } from '../components/holdings/HoldingCard';
import { V2_ROUTES } from '../lib/routes';

const TOKEN_TYPE_COLORS: Record<string, string> = {
  crypto: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  stock: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  fiat: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  bond: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  commodity: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
};

function formatMoney(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function InstitutionIcon({ name, website }: { name: string; website?: string }) {
  const favicon = getFaviconUrl(website);
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      {favicon && (
        <img
          src={favicon}
          alt=""
          className="h-4 w-4 rounded-sm object-contain"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      )}
      {name}
    </span>
  );
}

const holdingColumns: ColumnDef<HoldingWithDetails>[] = [
  {
    key: 'token',
    label: 'Token',
    sortable: true,
    render: (item) => (
      <div className="flex items-center gap-2">
        <span className="font-medium text-sm">{item.token.symbol}</span>
        <span className="text-xs text-muted-foreground truncate max-w-[120px]">
          {item.token.name}
        </span>
        <Badge
          variant="secondary"
          className={cn(
            'text-[10px] px-1.5 py-0',
            TOKEN_TYPE_COLORS[item.token.typeCode.toLowerCase()] ?? 'bg-secondary'
          )}
        >
          {item.token.typeCode}
        </Badge>
      </div>
    ),
  },
  {
    key: 'amount',
    label: 'Amount',
    align: 'right',
    sortable: true,
    render: (item) => <span className="tabular-nums">{item.amount.toLocaleString()}</span>,
  },
  {
    key: 'value',
    label: 'Value',
    align: 'right',
    sortable: true,
    render: (item) => <span className="font-medium tabular-nums">{formatMoney(item.value)}</span>,
  },
  {
    key: 'price',
    label: 'Price',
    align: 'right',
    sortable: true,
    render: (item) => (
      <span className="text-muted-foreground tabular-nums">
        {item.price ? `$${Number.parseFloat(item.price.value).toLocaleString()}` : '-'}
      </span>
    ),
  },
  {
    key: 'account',
    label: 'Account',
    render: (item) => <span className="text-sm text-muted-foreground">{item.account.name}</span>,
  },
  {
    key: 'institution',
    label: 'Institution',
    render: (item) => (
      <InstitutionIcon name={item.institution.name} website={item.institution.website} />
    ),
  },
  {
    key: 'groups',
    label: 'Groups',
    render: (item) => (
      <div className="flex flex-wrap gap-1">
        {item.groups.map((g) => (
          <Badge
            key={g.id}
            variant="outline"
            className="text-[10px] px-1.5 py-0"
            style={{ borderColor: g.color, color: g.color }}
          >
            {g.name}
          </Badge>
        ))}
      </div>
    ),
  },
];

export function HoldingsPage() {
  const { data: holdingsData, isLoading } = trpc.holdings.getWithDetails.useQuery();
  const { data: groupsData } = trpc.groups.getAll.useQuery();
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const navigate = useNavigate();

  const holdings = holdingsData?.holdings ?? [];
  const groups = groupsData ?? [];
  const currency = baseCurrency?.symbol || 'USD';

  const tokenTypeOptions = Array.from(new Set(holdings.map((h) => h.token.typeCode))).map(
    (code) => ({ label: code, value: code })
  );
  const institutionOptions = Array.from(
    new Map(holdings.map((h) => [h.institution.id, h.institution])).values()
  ).map((inst) => ({ label: inst.name, value: inst.id }));
  const accountOptions = Array.from(
    new Map(holdings.map((h) => [h.account.id, h.account])).values()
  ).map((acc) => ({ label: acc.name, value: acc.id }));
  const groupOptions = groups.map((g) => ({ label: g.name, value: g.id }));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Holdings</h2>
        <p className="text-muted-foreground mt-1">
          {isLoading ? '' : `${holdings.length} holdings`}
          {!isLoading && currency !== 'USD' ? ` (${currency})` : ''}
        </p>
      </div>

      <DataViewComponent
        config={{
          pageKey: 'holdings',
          data: holdings,
          searchFn: (item: HoldingWithDetails, query: string) => {
            const q = query.toLowerCase();
            return (
              item.token.symbol.toLowerCase().includes(q) ||
              item.token.name.toLowerCase().includes(q) ||
              item.account.name.toLowerCase().includes(q) ||
              item.institution.name.toLowerCase().includes(q)
            );
          },
          filterDefs: [
            {
              key: 'tokenType',
              label: 'Token Type',
              options: tokenTypeOptions,
              fn: (item: HoldingWithDetails, value: string) => item.token.typeCode === value,
            },
            {
              key: 'institution',
              label: 'Institution',
              options: institutionOptions,
              fn: (item: HoldingWithDetails, value: string) => item.institution.id === value,
            },
            {
              key: 'account',
              label: 'Account',
              options: accountOptions,
              fn: (item: HoldingWithDetails, value: string) => item.account.id === value,
            },
            {
              key: 'group',
              label: 'Group',
              options: groupOptions,
              fn: (item: HoldingWithDetails, value: string) =>
                item.groups.some((g) => g.id === value),
            },
          ],
          sortDefs: [
            { key: 'value', label: 'Value' },
            { key: 'symbol', label: 'Symbol' },
            { key: 'amount', label: 'Amount' },
            { key: 'price', label: 'Price' },
          ],
          sortFn: (a: HoldingWithDetails, b: HoldingWithDetails, field: string, dir: string) => {
            const mult = dir === 'asc' ? 1 : -1;
            switch (field) {
              case 'value':
                return (a.value - b.value) * mult;
              case 'symbol':
                return a.token.symbol.localeCompare(b.token.symbol) * mult;
              case 'amount':
                return (a.amount - b.amount) * mult;
              case 'price': {
                const pa = a.price ? Number.parseFloat(a.price.value) : 0;
                const pb = b.price ? Number.parseFloat(b.price.value) : 0;
                return (pa - pb) * mult;
              }
              default:
                return 0;
            }
          },
          groupByDefs: [
            {
              key: 'institution',
              label: 'Institution',
              fn: (item: HoldingWithDetails) => item.institution.name,
            },
            {
              key: 'account',
              label: 'Account',
              fn: (item: HoldingWithDetails) => item.account.name,
            },
            {
              key: 'tokenType',
              label: 'Token Type',
              fn: (item: HoldingWithDetails) => item.token.typeCode,
            },
          ],
          defaultSort: { field: 'value', direction: 'desc' },
          defaultView: 'table',
        }}
        columns={holdingColumns}
        renderCard={(
          item: HoldingWithDetails,
          isSelected: boolean,
          onSelect: (id: string) => void
        ) => <HoldingCard item={item} isSelected={isSelected} onSelect={onSelect} />}
        renderBulkActions={(ids: Set<string>, clear: () => void) => (
          <HoldingBulkActions selectedIds={ids} onClear={clear} />
        )}
        onRowClick={(item: HoldingWithDetails) => navigate(V2_ROUTES.holdingDetail(item.id))}
        getId={(item: HoldingWithDetails) => item.id}
        isLoading={isLoading}
        emptyState={
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <PieChart className="h-10 w-10 text-muted-foreground mb-3" />
            <h3 className="text-lg font-semibold">No holdings</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Add holdings to start tracking your portfolio.
            </p>
          </div>
        }
      />
    </div>
  );
}
