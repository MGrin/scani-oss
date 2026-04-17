import type { AccountWihSumaryDTO } from '@scani/shared';
import { Wallet } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { getFaviconUrl } from '@/lib/icons';
import { trpc } from '@/lib/trpc';
import { AccountBulkActions } from '../components/accounts/AccountBulkActions';
import { AccountCard } from '../components/accounts/AccountCard';
import { DataView as DataViewComponent } from '../components/data-view/DataView';
import type { ColumnDef } from '../components/data-view/DataViewTable';
import { AssignGroupsDialog } from '../components/groups/AssignGroupsDialog';
import { ConfirmDialog } from '../components/shared/ConfirmDialog';
import { useAccountActions } from '../hooks/useAccountActions';
import { useBaseCurrency } from '../hooks/useBaseCurrency';
import { formatMoney } from '../lib/format';
import { V2_ROUTES } from '../lib/routes';

export function AccountsPage() {
  const { data: accountsData, isLoading } = trpc.accounts.getByUserIdWithSummary.useQuery();
  const { data: groupsData } = trpc.groups.getAll.useQuery();
  const { data: institutions } = trpc.institutions.getByUserId.useQuery();
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();
  const navigate = useNavigate();
  const { symbol: currencySymbol } = useBaseCurrency();
  const [showEmpty, setShowEmpty] = useState(false);
  const { bulkDelete, isBulkDeleting } = useAccountActions();
  const [deleteConfirmIds, setDeleteConfirmIds] = useState<Set<string> | null>(null);
  const [assignGroupsIds, setAssignGroupsIds] = useState<Set<string> | null>(null);
  // Stash the DataView's clearSelection so confirm-dialog and assign-groups
  // flows (which both live outside the renderBulkActions closure) can clear
  // the selection footer once their mutations settle.
  const clearSelectionRef = useRef<(() => void) | null>(null);

  const allAccounts = accountsData ?? [];
  const emptyCount = useMemo(
    () => allAccounts.filter((a) => a.summary.holdingsCount === 0).length,
    [allAccounts]
  );
  // Hide accounts with no holdings by default
  const accounts = useMemo(
    () => (showEmpty ? allAccounts : allAccounts.filter((a) => a.summary.holdingsCount > 0)),
    [allAccounts, showEmpty]
  );
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

  const accountColumns: ColumnDef<AccountWihSumaryDTO>[] = useMemo(
    () => [
      {
        key: 'name',
        label: 'Name',
        sortable: true,
        render: (item) => <span className="font-medium text-sm">{item.name}</span>,
      },
      {
        key: 'institution',
        label: 'Institution',
        render: (item) => {
          const inst = institutionMap.get(item.institutionId);
          const favicon = getFaviconUrl(inst?.website);
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
              {inst?.name ?? item.institutionId}
            </span>
          );
        },
      },
      {
        key: 'type',
        label: 'Type',
        render: (item) => (
          <span className="text-sm text-muted-foreground">
            {typeMap.get(item.typeId)?.name ?? item.typeId}
          </span>
        ),
      },
      {
        key: 'holdingsCount',
        label: 'Holdings',
        align: 'right' as const,
        sortable: true,
        render: (item) => <span className="tabular-nums">{item.summary.holdingsCount}</span>,
      },
      {
        key: 'totalValue',
        label: 'Total Value',
        align: 'right' as const,
        sortable: true,
        render: (item) => (
          <span className="font-medium tabular-nums">
            {formatMoney(Number.parseFloat(item.summary.totalValue), currencySymbol)}
          </span>
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
    ],
    [institutionMap, typeMap, currencySymbol]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Accounts</h2>
          <p className="text-muted-foreground mt-1">
            {isLoading ? '' : `${accounts.length} accounts`}
          </p>
        </div>
        {emptyCount > 0 && (
          <button
            type="button"
            onClick={() => setShowEmpty((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors mt-2"
          >
            {showEmpty ? 'Hide' : 'Show'} {emptyCount} empty
          </button>
        )}
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
        ) => {
          const inst = institutionMap.get(item.institutionId);
          return (
            <AccountCard
              item={item}
              isSelected={isSelected}
              onSelect={onSelect}
              institutionName={inst?.name}
              typeName={typeMap.get(item.typeId)?.name}
              institutionFavicon={getFaviconUrl(inst?.website)}
            />
          );
        }}
        renderBulkActions={(ids: Set<string>, clear: () => void) => {
          clearSelectionRef.current = clear;
          return (
            <AccountBulkActions
              selectedIds={ids}
              onClear={clear}
              onDelete={(selectedIds) => setDeleteConfirmIds(selectedIds)}
              onAssignGroups={(selectedIds) => setAssignGroupsIds(selectedIds)}
            />
          );
        }}
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

      <ConfirmDialog
        open={deleteConfirmIds !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirmIds(null);
        }}
        title="Delete Accounts"
        description={`Are you sure you want to delete ${deleteConfirmIds?.size ?? 0} account(s)? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        isPending={isBulkDeleting}
        onConfirm={() => {
          if (deleteConfirmIds) {
            bulkDelete(Array.from(deleteConfirmIds), {
              onSuccess: () => {
                setDeleteConfirmIds(null);
                clearSelectionRef.current?.();
              },
            });
          }
        }}
      />

      <AssignGroupsDialog
        open={assignGroupsIds !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAssignGroupsIds(null);
            // Clear selection once the dialog closes so the bulk-action
            // footer doesn't persist between dialog open/close cycles.
            clearSelectionRef.current?.();
          }
        }}
        entityType="accounts"
        entityIds={assignGroupsIds ? Array.from(assignGroupsIds) : []}
      />
    </div>
  );
}
