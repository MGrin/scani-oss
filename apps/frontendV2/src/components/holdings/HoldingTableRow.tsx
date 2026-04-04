import type { HoldingWithDetails, Token } from '@scani/shared';
import type { ReactNode } from 'react';
import { AccountBadge, InstitutionBadge, TokenTypeBadge } from '@/components/features';
import { DataTable } from '@/components/ui/data-table';
import { MoneyDisplay } from '@/components/ui/money-display';

interface HoldingsTableProps {
  holdings: HoldingWithDetails[];
  baseCurrencyToken: Token;
  selectedRows: Set<string>;
  onSort: (field: string) => void;
  onRowClick: (holding: HoldingWithDetails) => void;
  onSelectRow: (id: string) => void;
  onSelectAll: (selected: boolean) => void;
  renderActions: (holding: HoldingWithDetails) => ReactNode;
}

export function HoldingsTable({
  holdings,
  baseCurrencyToken,
  selectedRows,
  onSort,
  onRowClick,
  onSelectRow,
  onSelectAll,
  renderActions,
}: HoldingsTableProps) {
  return (
    <DataTable
      data={holdings}
      columns={[
        {
          header: 'Token',
          accessor: (row) => (
            <div>
              <div className="font-medium flex items-center gap-2">{row.token.symbol}</div>
              <div className="text-sm text-muted-foreground">{row.token.name}</div>
              <TokenTypeBadge tokenTypeCode={row.token.typeCode} />
            </div>
          ),
          sortable: true,
        },
        {
          header: 'Amount',
          accessor: (row) => {
            return row.amount;
          },
          className: 'font-mono',
          sortable: true,
        },
        {
          header: 'Value',
          accessor: (row) => <MoneyDisplay value={row.value} token={baseCurrencyToken} />,
          className: 'font-mono font-medium',
          sortable: true,
        },
        {
          header: 'Institution',
          accessor: (row) => (
            <InstitutionBadge
              institutionId={row.institution.id}
              institutionName={row.institution.name}
              institutionWebsite={row.institution.website ?? undefined}
            />
          ),
          sortable: true,
        },
        {
          header: 'Account',
          accessor: (row) => (
            <AccountBadge
              accountId={row.account.id}
              accountName={row.account.name}
              accountTypeCode={row.account.typeCode}
            />
          ),
        },
        {
          header: 'Status',
          accessor: (row) => (
            <span
              className={`text-xs px-2 py-1 rounded-full ${
                row.isActive
                  ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                  : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400'
              }`}
            >
              {row.isActive ? 'Active' : 'Inactive'}
            </span>
          ),
          sortable: false,
        },
      ]}
      getRowKey={(row) => row.id}
      onSort={onSort}
      onRowClick={(row) => onRowClick(row)}
      actions={renderActions}
      selectable={true}
      selectedRows={selectedRows}
      onSelectRow={onSelectRow}
      onSelectAll={onSelectAll}
    />
  );
}
