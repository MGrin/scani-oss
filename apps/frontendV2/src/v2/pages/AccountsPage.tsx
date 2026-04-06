import type { AccountWihSumaryDTO } from '@scani/shared';
import { Wallet } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { AccountBulkActions } from '../components/accounts/AccountBulkActions';
import { AccountCard } from '../components/accounts/AccountCard';
import { DataView as DataViewComponent } from '../components/data-view/DataView';
import { V2_ROUTES } from '../lib/routes';

const accountColumns = [
  { key: 'select', label: '', width: '40px' },
  { key: 'name', label: 'Name' },
  { key: 'institution', label: 'Institution' },
  { key: 'type', label: 'Type' },
  { key: 'holdingsCount', label: 'Holdings', align: 'right' as const },
  { key: 'totalValue', label: 'Total Value', align: 'right' as const },
  { key: 'groups', label: 'Groups' },
];

export function AccountsPage() {
  const { data: accountsData, isLoading } = trpc.accounts.getByUserIdWithSummary.useQuery();
  const { data: groupsData } = trpc.groups.getAll.useQuery();
  const { data: institutions } = trpc.institutions.getByUserId.useQuery();
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();
  const navigate = useNavigate();

  const accounts = accountsData ?? [];
  const groups = groupsData ?? [];

  const institutionMap = useMemo(
    () => new Map((institutions ?? []).map((i) => [i.id, i])),
    [institutions]
  );
  const typeMap = useMemo(
    () => new Map((accountTypes ?? []).map((t) => [t.id, t])),
    [accountTypes]
  );

  const institutionOptions = Array.from(
    new Map(
      accounts.map((a) => {
        const inst = institutionMap.get(a.institutionId);
        return [a.institutionId, { label: inst?.name ?? a.institutionId, value: a.institutionId }];
      })
    ).values()
  );
  const typeOptions = Array.from(
    new Map(
      accounts.map((a) => {
        const t = typeMap.get(a.typeId);
        return [a.typeId, { label: t?.name ?? a.typeId, value: a.typeId }];
      })
    ).values()
  );
  const groupOptions = groups.map((g) => ({ label: g.name, value: g.id }));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Accounts</h2>
        <p className="text-muted-foreground mt-1">{accounts.length} accounts</p>
      </div>

      <DataViewComponent
        config={{
          pageKey: 'accounts',
          data: accounts,
          searchFn: (item: AccountWihSumaryDTO, query: string) => {
            const q = query.toLowerCase();
            const instName = institutionMap.get(item.institutionId)?.name ?? '';
            return item.name.toLowerCase().includes(q) || instName.toLowerCase().includes(q);
          },
          filterDefs: [
            {
              key: 'institution',
              label: 'Institution',
              options: institutionOptions,
              fn: (item: AccountWihSumaryDTO, value: string) => item.institutionId === value,
            },
            {
              key: 'type',
              label: 'Account Type',
              options: typeOptions,
              fn: (item: AccountWihSumaryDTO, value: string) => item.typeId === value,
            },
            {
              key: 'group',
              label: 'Group',
              options: groupOptions,
              fn: (item: AccountWihSumaryDTO, value: string) =>
                item.groups.some((g) => g.id === value),
            },
          ],
          sortDefs: [
            { key: 'name', label: 'Name' },
            { key: 'totalValue', label: 'Total Value' },
            { key: 'holdingsCount', label: 'Holdings Count' },
          ],
          sortFn: (a: AccountWihSumaryDTO, b: AccountWihSumaryDTO, field: string, dir: string) => {
            const mult = dir === 'asc' ? 1 : -1;
            switch (field) {
              case 'name':
                return a.name.localeCompare(b.name) * mult;
              case 'totalValue':
                return (
                  (Number.parseFloat(a.summary.totalValue) -
                    Number.parseFloat(b.summary.totalValue)) *
                  mult
                );
              case 'holdingsCount':
                return (a.summary.holdingsCount - b.summary.holdingsCount) * mult;
              default:
                return 0;
            }
          },
          groupByDefs: [
            {
              key: 'institution',
              label: 'Institution',
              fn: (item: AccountWihSumaryDTO) =>
                institutionMap.get(item.institutionId)?.name ?? 'Unknown',
            },
            {
              key: 'type',
              label: 'Type',
              fn: (item: AccountWihSumaryDTO) => typeMap.get(item.typeId)?.name ?? 'Unknown',
            },
          ],
          defaultSort: { field: 'totalValue', direction: 'desc' },
          defaultView: 'table',
        }}
        columns={accountColumns}
        renderCard={(
          item: AccountWihSumaryDTO,
          isSelected: boolean,
          onSelect: (id: string) => void
        ) => (
          <AccountCard
            item={item}
            isSelected={isSelected}
            onSelect={onSelect}
            institutionName={institutionMap.get(item.institutionId)?.name}
            typeName={typeMap.get(item.typeId)?.name}
          />
        )}
        renderBulkActions={(ids: Set<string>, clear: () => void) => (
          <AccountBulkActions selectedIds={ids} onClear={clear} />
        )}
        onRowClick={(item: AccountWihSumaryDTO) => navigate(V2_ROUTES.accountDetail(item.id))}
        getId={(item: AccountWihSumaryDTO) => item.id}
        isLoading={isLoading}
        emptyState={
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Wallet className="h-10 w-10 text-muted-foreground mb-3" />
            <h3 className="text-lg font-semibold">No accounts</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Add accounts to start organizing your holdings.
            </p>
          </div>
        }
      />
    </div>
  );
}
