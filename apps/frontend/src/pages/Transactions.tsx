import type { Transaction } from '@scani/shared';
import { CreditCard, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  HoldingFilterSelector,
  TransactionTypeSelector,
} from '@/components/selectors/SearchableSelectors';
import { TransactionForm } from '@/components/TransactionForm';
import { TransactionRow } from '@/components/TransactionRow';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { PageAggregation } from '@/components/ui/page-aggregation';
import { PageHeader } from '@/components/ui/page-header';

import { useToast } from '@/hooks/use-toast';
import { useFilters } from '@/hooks/useFilters';
import type { ApiAccount, ApiHolding, ApiToken } from '@/lib/api-types';
import { trpc } from '@/lib/trpc';

export function Transactions() {
  const { toast } = useToast();

  const navigate = useNavigate();

  const {
    filters: filterValues,
    updateFilter,
    clearAllFilters,
    hasActiveFilters,
  } = useFilters([
    { key: 'search', defaultValue: '' },
    { key: 'type', defaultValue: 'all' },
    { key: 'holding', defaultValue: 'all' },
  ]);

  const { institutionId, accountId, holdingId } = useParams<{
    institutionId: string;
    accountId: string;
    holdingId: string;
  }>();
  const [isTransactionFormOpen, setIsTransactionFormOpen] = useState(false);
  const [transactionToEdit, setTransactionToEdit] = useState<Transaction | undefined>();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [transactionToDelete, setTransactionToDelete] = useState<Transaction | undefined>();

  const { data: transactions, isLoading } = trpc.transactions.getAll.useQuery();
  const { data: accounts } = trpc.accounts.getAll.useQuery();
  const { data: holdings } = trpc.holdings.getAll.useQuery();
  const { data: tokens } = trpc.tokens.getAll.useQuery();
  const { data: userPrefs } = trpc.users.getCurrent.useQuery();
  const { data: transactionTypes } = trpc.transactionTypes.getAll.useQuery();

  // Determine if we're in hierarchical mode
  const isHierarchicalMode = Boolean(institutionId && accountId && holdingId);

  // Compute hasActiveFilters - always include all filters and search term
  const hasActiveFiltersComputed = hasActiveFilters || Boolean(filterValues.search);

  // Clear all filters helper - exits hierarchical mode when clearing all
  const handleClearAllFilters = () => {
    // If in hierarchical mode, navigate back to normal transactions page
    if (isHierarchicalMode) {
      navigate('/transactions', { replace: true });
    } else {
      // In normal mode, just clear filters
      clearAllFilters();
    }
  };

  // Sync holding filter when navigating between routes
  useEffect(() => {
    if (holdingId && holdingId !== filterValues.holding) {
      // Set the holding filter to match the URL param
      updateFilter('holding', holdingId);
    } else if (!holdingId && filterValues.holding !== 'all') {
      // Clear the holding filter when not in hierarchical mode
      updateFilter('holding', 'all');
    }
  }, [holdingId, filterValues.holding, updateFilter]);

  // Handle holding filter changes with navigation
  const handleHoldingFilterChange = (value: string) => {
    if (value === 'all') {
      // User selected "All Holdings" - go to normal transactions page
      navigate('/transactions', { replace: true });
    } else if (value.includes(',')) {
      // Multiple holdings selected - exit hierarchical mode and go to transactions page
      navigate('/transactions', { replace: true });
      updateFilter('holding', value);
    } else if (value !== holdingId) {
      // User selected a single holding - navigate to that holding's transactions page
      // Need to find the account and institution for this holding
      const holding = holdings?.find((h) => h.id === value);
      const account = accounts?.find((acc) => acc.id === holding?.accountId);
      if (holding && account) {
        navigate(
          `/institutions/${account.institutionId}/accounts/${account.id}/holdings/${value}`,
          { replace: true }
        );
      }
    }
    // If same holding selected, no navigation needed
  };

  // Determine effective holding filter - use the current filter value
  const effectiveFilterByHolding = filterValues.holding !== 'all' ? filterValues.holding : null;

  // Parse holding filter for multiple selections
  const holdingFilterIds = effectiveFilterByHolding
    ? effectiveFilterByHolding.includes(',')
      ? effectiveFilterByHolding.split(',').map((id) => id.trim())
      : [effectiveFilterByHolding]
    : [];

  const utils = trpc.useUtils();

  const deleteTransaction = trpc.transactions.delete.useMutation({
    onSuccess: () => {
      toast({
        title: '✅ Transaction deleted',
        description: 'The transaction has been successfully deleted.',
      });
      utils.transactions.getAll.invalidate();
      utils.holdings.getAll.invalidate();
      utils.accounts.getAll.invalidate();
      setIsDeleteDialogOpen(false);
      setTransactionToDelete(undefined);
    },
    onError: (error) => {
      toast({
        title: 'Error deleting transaction',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  // Create maps for quick lookups
  const accountsMap = accounts
    ? Object.fromEntries(accounts.map((acc: ApiAccount) => [acc.id, acc]))
    : {};
  const holdingsMap = holdings
    ? Object.fromEntries(holdings.map((holding: ApiHolding) => [holding.id, holding]))
    : {};
  const tokensMap = tokens
    ? Object.fromEntries(tokens.map((token: ApiToken) => [token.id, token]))
    : {};

  // Filter transactions based on search and filter criteria
  const baseTransactions = transactions || [];

  // Apply holding filter if specified
  const holdingFilteredTransactions = effectiveFilterByHolding
    ? baseTransactions.filter((transaction) => holdingFilterIds.includes(transaction.holdingId))
    : baseTransactions;

  // Apply search and type filters
  const filteredTransactions = holdingFilteredTransactions.filter((transaction) => {
    const holding = holdingsMap[transaction.holdingId];
    const account = holding ? accountsMap[holding.accountId] : null;
    const token = holding ? tokensMap[holding.tokenId] : null;

    // Search filter
    const matchesSearch =
      !filterValues.search ||
      (transaction.description || '').toLowerCase().includes(filterValues.search.toLowerCase()) ||
      transaction.type.toLowerCase().includes(filterValues.search.toLowerCase()) ||
      (account?.name || '').toLowerCase().includes(filterValues.search.toLowerCase()) ||
      (token?.name || '').toLowerCase().includes(filterValues.search.toLowerCase()) ||
      (token?.symbol || '').toLowerCase().includes(filterValues.search.toLowerCase());

    // Type filter
    const matchesFilter = filterValues.type === 'all' || transaction.type === filterValues.type;

    return matchesSearch && matchesFilter;
  });

  // Calculate aggregations in base currency
  const totalValue = filteredTransactions.reduce((sum, transaction) => {
    const baseCurrencyAmount = parseFloat(transaction.baseCurrencyAmount || transaction.amount);
    const value = ['deposit', 'sell', 'dividend', 'interest'].includes(transaction.type)
      ? Math.abs(baseCurrencyAmount)
      : ['withdrawal', 'buy'].includes(transaction.type)
        ? -Math.abs(baseCurrencyAmount)
        : Math.abs(baseCurrencyAmount);
    return sum + value;
  }, 0);

  const allTransactionsValue = baseTransactions.reduce((sum, transaction) => {
    const baseCurrencyAmount = parseFloat(transaction.baseCurrencyAmount || transaction.amount);
    const value = ['deposit', 'sell', 'dividend', 'interest'].includes(transaction.type)
      ? Math.abs(baseCurrencyAmount)
      : ['withdrawal', 'buy'].includes(transaction.type)
        ? -Math.abs(baseCurrencyAmount)
        : Math.abs(baseCurrencyAmount);
    return sum + value;
  }, 0);

  const getTransactionIcon = (type: string) => {
    switch (type) {
      case 'deposit':
        return '↓';
      case 'withdrawal':
        return '↑';
      case 'buy':
        return '📈';
      case 'sell':
        return '📉';
      case 'dividend':
        return '💰';
      case 'interest':
        return '💵';
      default:
        return '↔';
    }
  };

  const getTransactionColor = (type: string) => {
    if (['deposit', 'sell', 'dividend', 'interest'].includes(type)) {
      return 'bg-green-500';
    } else if (['withdrawal', 'buy'].includes(type)) {
      return 'bg-red-500';
    }
    return 'bg-blue-500';
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Transactions" subtitle="Track your financial activity" loading={true} />
        <Card>
          <CardContent className="p-6">
            <div className="animate-pulse space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="space-y-2">
                    <div className="h-4 bg-muted rounded w-48"></div>
                    <div className="h-3 bg-muted rounded w-32"></div>
                  </div>
                  <div className="h-4 bg-muted rounded w-20"></div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Action handlers
  const handleAddTransaction = () => {
    setTransactionToEdit(undefined);
    setIsTransactionFormOpen(true);
  };

  const handleEditTransaction = (transaction: {
    type: string;
    id: string;
    holdingId: string;
    amount: string;
    fee: string;
    timestamp: string;
    createdAt: string;
    updatedAt: string;
    description?: string | null;
    reference?: string | null;
    feeTokenId?: string | null;
  }) => {
    // Transform API data to proper Transaction type
    const properTransaction: Transaction = {
      id: transaction.id,
      holdingId: transaction.holdingId,
      type: transaction.type as Transaction['type'],
      amount: transaction.amount,
      fee: transaction.fee,
      timestamp: new Date(transaction.timestamp),
      createdAt: new Date(transaction.createdAt),
      updatedAt: new Date(transaction.updatedAt),
      description: transaction.description || undefined,
      reference: transaction.reference || undefined,
      feeTokenId: transaction.feeTokenId || undefined,
    };
    setTransactionToEdit(properTransaction);
    setIsTransactionFormOpen(true);
  };

  const handleDeleteTransaction = (transaction: {
    type: string;
    id: string;
    holdingId: string;
    amount: string;
    fee: string;
    timestamp: string;
    createdAt: string;
    updatedAt: string;
    description?: string | null;
    reference?: string | null;
    feeTokenId?: string | null;
  }) => {
    // Transform API data to proper Transaction type
    const properTransaction: Transaction = {
      id: transaction.id,
      holdingId: transaction.holdingId,
      type: transaction.type as Transaction['type'],
      amount: transaction.amount,
      fee: transaction.fee,
      timestamp: new Date(transaction.timestamp),
      createdAt: new Date(transaction.createdAt),
      updatedAt: new Date(transaction.updatedAt),
      description: transaction.description || undefined,
      reference: transaction.reference || undefined,
      feeTokenId: transaction.feeTokenId || undefined,
    };
    setTransactionToDelete(properTransaction);
    setIsDeleteDialogOpen(true);
  };

  const confirmDeleteTransaction = () => {
    if (transactionToDelete) {
      deleteTransaction.mutate({ id: transactionToDelete.id });
    }
  };

  // Dynamic title and subtitle based on filtering state
  const pageTitle = effectiveFilterByHolding
    ? (() => {
        const holdingInfo = holdingsMap[effectiveFilterByHolding];
        const tokenId = holdingInfo?.tokenId;
        return `${tokenId ? tokensMap[tokenId]?.name || 'Token' : 'Token'} Transactions`;
      })()
    : 'Transactions';

  const pageSubtitle = effectiveFilterByHolding
    ? (() => {
        const holdingInfo = holdingsMap[effectiveFilterByHolding];
        const accountId = holdingInfo?.accountId;
        const tokenId = holdingInfo?.tokenId;
        const accountName = accountId ? accountsMap[accountId]?.name : 'Account';
        const tokenSymbol = tokenId ? tokensMap[tokenId]?.symbol : 'Token';
        return `${accountName} - ${tokenSymbol}`;
      })()
    : undefined;

  return (
    <div className="space-y-4">
      <PageHeader
        title={pageTitle}
        subtitle={pageSubtitle}
        primaryAction={{
          label: 'Add Transaction',
          onClick: handleAddTransaction,
          icon: <Plus className="h-4 w-4 mr-1" />,
        }}
        secondaryActions={undefined}
      />

      <PageAggregation
        totalCount={baseTransactions.length}
        filteredCount={filteredTransactions.length}
        entityLabel="transactions"
        totalBalance={effectiveFilterByHolding ? totalValue : allTransactionsValue}
        filteredBalance={totalValue}
        baseCurrency={userPrefs?.baseCurrency?.symbol}
        searchTerm={filterValues.search || ''}
        onSearchChange={(value) => updateFilter('search', value)}
        searchPlaceholder="Search by description, type, account, or token..."
        filters={[
          <TransactionTypeSelector
            key="type"
            value={filterValues.type || 'all'}
            onValueChange={(value) => updateFilter('type', value)}
            transactionTypes={[
              { id: 'all', code: 'all', name: 'All Types' },
              ...(transactionTypes || []),
            ]}
            placeholder="Filter by type..."
          />,
          <HoldingFilterSelector
            key="holding"
            value={filterValues.holding || 'all'}
            onValueChange={handleHoldingFilterChange}
            holdings={holdings}
            tokens={tokens}
            accounts={accounts}
            placeholder="Filter by holding..."
          />,
        ]}
        hasActiveFilters={hasActiveFiltersComputed}
        onClearFilters={handleClearAllFilters}
      />

      {/* Transactions List */}
      {!filteredTransactions || filteredTransactions.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <CreditCard className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <div className="text-muted-foreground mb-4">No transactions found</div>
            <Button onClick={handleAddTransaction}>
              <Plus className="h-4 w-4 mr-2" />
              Add Your First Transaction
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredTransactions.map((transaction) => {
            const holding = holdingsMap[transaction.holdingId];
            const account = holding ? accountsMap[holding.accountId] : null;
            const token = holding ? tokensMap[holding.tokenId] : null;

            return (
              <TransactionRow
                key={transaction.id}
                transaction={transaction}
                account={account || undefined}
                token={token || undefined}
                onEdit={handleEditTransaction}
                onDelete={handleDeleteTransaction}
                getTransactionColor={getTransactionColor}
                getTransactionIcon={getTransactionIcon}
              />
            );
          })}
        </div>
      )}

      {/* Transaction Form Dialog */}
      <TransactionForm
        isOpen={isTransactionFormOpen}
        onClose={() => setIsTransactionFormOpen(false)}
        transaction={transactionToEdit}
        mode={transactionToEdit ? 'edit' : 'create'}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Transaction</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this transaction? This action cannot be undone and
              will permanently remove the transaction record.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
              disabled={deleteTransaction.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteTransaction}
              disabled={deleteTransaction.isPending}
            >
              {deleteTransaction.isPending ? 'Deleting...' : 'Delete Transaction'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
