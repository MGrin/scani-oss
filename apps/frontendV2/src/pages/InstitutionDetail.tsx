import { Edit, Grid3X3, List, MoreHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BulkEditGroupsModal } from '@/components/modals/BulkEditGroupsModal';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoneyDisplay } from '@/components/ui/money-display';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { SummaryCard } from '@/components/ui/summary-card';
import { showError, useToast } from '@/hooks/use-toast';
import { useViewMode } from '@/hooks/use-view-mode';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

export function InstitutionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  // View mode state
  const [viewMode, setViewMode] = useViewMode('cards');

  // Selection state for bulk operations
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [bulkEditGroupsModalOpen, setBulkEditGroupsModalOpen] = useState(false);

  // Fetch base currency
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const currency = baseCurrency?.symbol || 'USD';
  const baseCurrencyToken = createCurrencyToken(currency);

  // Fetch institution data
  const {
    data: institution,
    isLoading: institutionLoading,
    error: institutionError,
  } = trpc.institutions.getById.useQuery({ id: id! }, { enabled: !!id });

  // Fetch accounts for this institution
  const { data: allAccounts } = trpc.accounts.getAll.useQuery();
  const institutionAccounts = allAccounts?.filter((account) => account.institutionId === id) || [];

  // Fetch holdings for all accounts in this institution
  const { data: allHoldings } = trpc.holdings.getWithDetails.useQuery();
  const institutionHoldings =
    allHoldings?.holdings?.filter((holding) =>
      institutionAccounts.some((account) => account.id === holding.account.id)
    ) || [];

  // Fetch account types and institution types for display
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();
  const { data: institutionTypes } = trpc.institutionTypes.getAll.useQuery();

  // Delete account mutation
  const deleteAccountMutation = trpc.accounts.delete.useMutation({
    onSuccess: () => {
      toast({
        title: 'Account deleted',
        description: 'The account has been successfully deleted.',
      });
      // Invalidate queries
      utils.accounts.getAll.invalidate();
      utils.accounts.getByUserIdWithSummary.invalidate();
    },
    onError: (error) => showError(error, 'Deleting account'),
  });

  // Bulk delete accounts mutation
  const bulkDeleteAccountsMutation = trpc.accounts.bulkDelete.useMutation({
    onSuccess: (result) => {
      toast({
        title: result.failed > 0 ? 'Accounts partially deleted' : 'Accounts deleted',
        description:
          result.failed > 0
            ? `Successfully deleted ${result.deleted} of ${result.total} accounts. ${result.failed} failed.`
            : `Successfully deleted ${result.deleted} of ${result.total} accounts.`,
      });

      // Only clear successfully deleted items from selection
      if (result.failedIds && result.failedIds.length > 0) {
        setSelectedRows(new Set(result.failedIds));
      } else {
        setSelectedRows(new Set());
      }

      // Invalidate queries
      utils.accounts.getAll.invalidate();
      utils.accounts.getByUserIdWithSummary.invalidate();
    },
    onError: (error) => showError(error, 'Deleting accounts'),
  });

  const handleSelectRow = (rowKey: string) => {
    setSelectedRows((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(rowKey)) {
        newSet.delete(rowKey);
      } else {
        newSet.add(rowKey);
      }
      return newSet;
    });
  };

  const handleSelectAll = (selected: boolean) => {
    if (selected) {
      const allIds = institutionAccounts.map((account) => account.id);
      setSelectedRows(new Set(allIds));
    } else {
      setSelectedRows(new Set());
    }
  };

  const handleBulkDelete = () => {
    if (selectedRows.size === 0) return;

    const confirmed = window.confirm(
      `Are you sure you want to delete ${selectedRows.size} account${
        selectedRows.size !== 1 ? 's' : ''
      }?`
    );

    if (confirmed) {
      bulkDeleteAccountsMutation.mutate({ ids: Array.from(selectedRows) });
    }
  };

  const handleDeleteAccount = (accountId: string) => {
    const confirmed = window.confirm('Are you sure you want to delete this account?');
    if (confirmed) {
      deleteAccountMutation.mutate({ id: accountId });
    }
  };

  const renderActions = (account: { id: string }) => (
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
            handleDeleteAccount(account.id);
          }}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Remove Account
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (institutionLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="" loading={true} />

        {/* Skeleton summary cards */}
        <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-20 mb-2" />
              <Skeleton className="h-3 w-12" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-20" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16 mb-2" />
              <Skeleton className="h-3 w-16" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-28" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16 mb-2" />
              <Skeleton className="h-3 w-20" />
            </CardContent>
          </Card>
        </div>

        {/* Skeleton accounts list */}
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {[1, 2, 3, 4].map((num) => (
                <div key={num} className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-8 w-8 rounded-full" />
                    <div>
                      <Skeleton className="h-4 w-24 mb-1" />
                      <Skeleton className="h-3 w-16" />
                    </div>
                  </div>
                  <div className="text-right">
                    <Skeleton className="h-4 w-20 mb-1" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (institutionError || !institution) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Institution Not Found"
          subtitle="The requested institution could not be found"
        />
      </div>
    );
  }

  const totalValue = institutionAccounts.reduce((sum, account) => {
    const accountHoldings = institutionHoldings.filter(
      (holding) => holding.account.id === account.id && holding.isActive
    );
    return sum + accountHoldings.reduce((accSum, holding) => accSum + holding.value, 0);
  }, 0);

  const institutionType = institutionTypes?.find((type) => type.id === institution.typeId);

  return (
    <div className="space-y-6">
      <PageHeader
        title={institution.name}
        subtitle={`Institution • ${institutionType?.name || 'Unknown Type'}`}
      />

      {/* Institution Summary */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
        <SummaryCard type="currency" title="Total Value" value={totalValue} currency={currency} />

        <SummaryCard
          type="count"
          title="Accounts"
          value={institutionAccounts.length}
          label="accounts"
        />

        <SummaryCard
          type="count"
          title="Holdings"
          value={institutionHoldings.filter((h) => h.isActive).length}
          label="holdings"
        />
      </div>

      {/* Accounts within this Institution */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Accounts</h2>
          <div className="flex items-center gap-2">
            <Button
              variant={viewMode === 'cards' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setViewMode('cards')}
            >
              <Grid3X3 className="h-4 w-4 mr-2" />
              Cards
            </Button>
            <Button
              variant={viewMode === 'table' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setViewMode('table')}
            >
              <List className="h-4 w-4 mr-2" />
              Table
            </Button>
          </div>
        </div>

        {institutionAccounts.length === 0 ? (
          <p className="text-muted-foreground">No accounts in this institution yet.</p>
        ) : viewMode === 'table' ? (
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
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setBulkEditGroupsModalOpen(true)}
                      >
                        <Edit className="h-4 w-4 mr-2" />
                        Edit Selected
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={handleBulkDelete}
                        disabled={bulkDeleteAccountsMutation.isPending}
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
              data={institutionAccounts}
              columns={[
                {
                  header: 'Account',
                  accessor: (row) => (
                    <div>
                      <div className="font-medium">{row.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {accountTypes?.find((type) => type.id === row.typeId)?.name ||
                          'Unknown Type'}
                      </div>
                    </div>
                  ),
                  sortable: true,
                },
                {
                  header: 'Holdings',
                  accessor: (row) => {
                    const accountHoldings = institutionHoldings.filter(
                      (holding) => holding.account.id === row.id && holding.isActive
                    );
                    return `${accountHoldings.length} holding${
                      accountHoldings.length !== 1 ? 's' : ''
                    }`;
                  },
                  className: 'text-muted-foreground',
                },
                {
                  header: 'Value',
                  accessor: (row) => {
                    const accountHoldings = institutionHoldings.filter(
                      (holding) => holding.account.id === row.id && holding.isActive
                    );
                    const accountValue = accountHoldings.reduce(
                      (sum, holding) => sum + holding.value,
                      0
                    );
                    return <MoneyDisplay value={accountValue} token={baseCurrencyToken} />;
                  },
                  className: 'font-mono font-medium',
                  sortable: true,
                },
              ]}
              getRowKey={(row) => row.id}
              onRowClick={(row) => navigate(`/accounts/${row.id}`)}
              actions={renderActions}
              selectable={true}
              selectedRows={selectedRows}
              onSelectRow={handleSelectRow}
              onSelectAll={handleSelectAll}
            />
          </>
        ) : (
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
            {institutionAccounts.map((account) => {
              const accountHoldings = institutionHoldings.filter(
                (holding) => holding.account.id === account.id && holding.isActive
              );
              const accountValue = accountHoldings.reduce((sum, holding) => sum + holding.value, 0);
              const accountType = accountTypes?.find((type) => type.id === account.typeId);

              return (
                <Link key={account.id} to={`/accounts/${account.id}`}>
                  <Card className="hover:shadow-md transition-shadow cursor-pointer">
                    <CardHeader>
                      <CardTitle className="flex items-center justify-between">
                        <span>{account.name}</span>
                        <div className="text-sm text-muted-foreground">
                          {accountType?.name || 'Unknown Type'}
                        </div>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-lg font-semibold">
                        <MoneyDisplay value={accountValue} token={baseCurrencyToken} />
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {accountHoldings.length} holdings
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <BulkEditGroupsModal
        open={bulkEditGroupsModalOpen}
        onOpenChange={setBulkEditGroupsModalOpen}
        entityType="account"
        selectedEntityIds={Array.from(selectedRows)}
        onSuccess={() => {
          utils.accounts.getAll.invalidate();
          toast({
            title: 'Success',
            description: 'Groups updated successfully',
          });
        }}
      />
    </div>
  );
}
