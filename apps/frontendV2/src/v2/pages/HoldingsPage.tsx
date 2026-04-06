import type { HoldingWithDetails } from '@scani/shared';
import { PieChart } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { DataView as DataViewComponent } from '../components/data-view/DataView';
import { HoldingBulkActions } from '../components/holdings/HoldingBulkActions';
import { HoldingCard } from '../components/holdings/HoldingCard';
import { V2_ROUTES } from '../lib/routes';

const holdingColumns = [
  { key: 'select', label: '', width: '40px' },
  { key: 'token', label: 'Token' },
  { key: 'amount', label: 'Amount', align: 'right' as const },
  { key: 'value', label: 'Value', align: 'right' as const },
  { key: 'price', label: 'Price', align: 'right' as const },
  { key: 'account', label: 'Account' },
  { key: 'institution', label: 'Institution' },
  { key: 'groups', label: 'Groups' },
  { key: 'status', label: 'Status' },
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
          {holdings.length} holdings{currency !== 'USD' ? ` (${currency})` : ''}
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
