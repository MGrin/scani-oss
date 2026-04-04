import type { Token } from '@scani/shared';
import { Edit, MoreHorizontal, Trash2 } from 'lucide-react';
import { InstitutionBadge } from '@/components/features';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoneyDisplay } from '@/components/ui/money-display';

type Account = {
  id: string;
  institutionId: string;
  name: string;
  typeId: string;
  summary: {
    holdingsCount: number;
    totalValue: string;
  };
  // biome-ignore lint/suspicious/noExplicitAny: Account type from query includes groups at runtime
  groups: any[];
};

interface AccountTableViewProps {
  accounts: Account[];
  institutions: { id: string; name: string; website: string | null }[] | undefined;
  accountTypes: { id: string; name: string }[] | undefined;
  baseCurrencyToken: Token;
  selectedRows: Set<string>;
  bulkDeletePending: boolean;
  onSort: (field: string) => void;
  onRowClick: (id: string) => void;
  onSelectRow: (id: string) => void;
  onSelectAll: (selected: boolean) => void;
  onDeleteAccount: (account: Account) => void;
  onBulkEditGroups: () => void;
  onBulkDelete: () => void;
}

export function AccountTableView({
  accounts,
  institutions,
  accountTypes,
  baseCurrencyToken,
  selectedRows,
  bulkDeletePending,
  onSort,
  onRowClick,
  onSelectRow,
  onSelectAll,
  onDeleteAccount,
  onBulkEditGroups,
  onBulkDelete,
}: AccountTableViewProps) {
  const renderActions = (account: Account) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-8 w-8 p-0">
          <span className="sr-only">Open menu</span>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            onDeleteAccount(account);
          }}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Remove Account
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      {selectedRows.size > 0 && (
        <Card className="mb-4">
          <CardContent className="py-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {selectedRows.size} account
                {selectedRows.size !== 1 ? 's' : ''} selected
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={onBulkEditGroups}>
                  <Edit className="h-4 w-4 mr-2" />
                  Edit Selected
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={onBulkDelete}
                  disabled={bulkDeletePending}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Selected
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      <DataTable
        data={accounts}
        columns={[
          {
            header: 'Account',
            accessor: (row) => (
              <div>
                <div className="font-medium">{row.name}</div>
                <div className="text-sm text-muted-foreground">
                  {accountTypes?.find((type) => type.id === row.typeId)?.name || 'Unknown Type'}
                </div>
              </div>
            ),
            sortable: true,
          },
          {
            header: 'Institution',
            accessor: (row) => (
              <InstitutionBadge
                institutionId={row.institutionId}
                institutionName={
                  institutions?.find((inst) => inst.id === row.institutionId)?.name || 'Unknown'
                }
                institutionWebsite={
                  institutions?.find((inst) => inst.id === row.institutionId)?.website || undefined
                }
              />
            ),
            sortable: true,
          },
          {
            header: 'Balance',
            accessor: (row) => (
              <MoneyDisplay value={parseFloat(row.summary.totalValue)} token={baseCurrencyToken} />
            ),
            className: 'font-mono font-medium',
            sortable: true,
          },
          {
            header: 'Groups',
            accessor: (row) => {
              const groups = row.groups;
              if (!groups || groups.length === 0) {
                return <span className="text-xs text-muted-foreground">-</span>;
              }
              return (
                <div className="flex flex-wrap gap-1">
                  {/* biome-ignore lint/suspicious/noExplicitAny: Account type doesn't know about groups at compile time */}
                  {groups.slice(0, 2).map((group: any) => (
                    <Badge
                      key={group.id}
                      variant="outline"
                      className="text-xs truncate"
                      style={{
                        backgroundColor: group.color,
                        opacity: 0.2,
                      }}
                    >
                      {group.name}
                    </Badge>
                  ))}
                  {groups.length > 2 && (
                    <Badge variant="secondary" className="text-xs">
                      +{groups.length - 2}
                    </Badge>
                  )}
                </div>
              );
            },
          },
          {
            header: 'Holdings',
            accessor: (row) =>
              `${row.summary.holdingsCount} holding${row.summary.holdingsCount !== 1 ? 's' : ''}`,
            className: 'text-muted-foreground',
          },
        ]}
        getRowKey={(row) => row.id}
        onSort={onSort}
        onRowClick={(row) => onRowClick(row.id)}
        actions={renderActions}
        selectable={true}
        selectedRows={selectedRows}
        onSelectRow={onSelectRow}
        onSelectAll={onSelectAll}
      />
    </>
  );
}
