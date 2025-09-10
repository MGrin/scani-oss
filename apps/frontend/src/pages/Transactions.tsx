import { FinancialMath, type Transaction } from '@scani/shared';
import { Edit2, Filter, MoreHorizontal, Plus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { TransactionForm } from '@/components/TransactionForm';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

export function Transactions() {
  const { toast } = useToast();
  const [isTransactionFormOpen, setIsTransactionFormOpen] = useState(false);
  const [transactionToEdit, setTransactionToEdit] = useState<Transaction | undefined>();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [transactionToDelete, setTransactionToDelete] = useState<Transaction | undefined>();

  const { data: transactions, isLoading } = trpc.transactions.getAll.useQuery();
  const { data: accounts } = trpc.accounts.getAll.useQuery();
  const { data: holdings } = trpc.holdings.getAll.useQuery();
  const { data: tokens } = trpc.tokens.getAll.useQuery();
  const { data: userPrefs } = trpc.users.getById.useQuery({
    id: 'test-user-1', // Replace with actual user ID from auth context
  });

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
  const accountsMap = accounts ? Object.fromEntries(accounts.map((acc) => [acc.id, acc])) : {};
  const holdingsMap = holdings
    ? Object.fromEntries(holdings.map((holding) => [holding.id, holding]))
    : {};
  const tokensMap = tokens ? Object.fromEntries(tokens.map((token) => [token.id, token])) : {};

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

  const getAmountColor = (type: string) => {
    if (['deposit', 'sell', 'dividend', 'interest'].includes(type)) {
      return 'text-green-600';
    } else if (['withdrawal', 'buy'].includes(type)) {
      return 'text-red-600';
    }
    return 'text-blue-600';
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
    amount: number;
    fee: number;
    timestamp: string;
    createdAt: string;
    updatedAt: string;
    price?: number | null;
    description?: string | null;
    reference?: string | null;
    priceTokenId?: string | null;
    feeTokenId?: string | null;
  }) => {
    // Transform API data to proper Transaction type
    const properTransaction: Transaction = {
      ...transaction,
      timestamp: new Date(transaction.timestamp),
      createdAt: new Date(transaction.createdAt),
      updatedAt: new Date(transaction.updatedAt),
      type: transaction.type as Transaction['type'],
      description: transaction.description || undefined,
      reference: transaction.reference || undefined,
      price: transaction.price ?? undefined,
      priceTokenId: transaction.priceTokenId || undefined,
      feeTokenId: transaction.feeTokenId || undefined,
    };
    setTransactionToEdit(properTransaction);
    setIsTransactionFormOpen(true);
  };

  const handleDeleteTransaction = (transaction: {
    type: string;
    id: string;
    holdingId: string;
    amount: number;
    fee: number;
    timestamp: string;
    createdAt: string;
    updatedAt: string;
    price?: number | null;
    description?: string | null;
    reference?: string | null;
    priceTokenId?: string | null;
    feeTokenId?: string | null;
  }) => {
    // Transform API data to proper Transaction type
    const properTransaction: Transaction = {
      ...transaction,
      timestamp: new Date(transaction.timestamp),
      createdAt: new Date(transaction.createdAt),
      updatedAt: new Date(transaction.updatedAt),
      type: transaction.type as Transaction['type'],
      description: transaction.description || undefined,
      reference: transaction.reference || undefined,
      price: transaction.price ?? undefined,
      priceTokenId: transaction.priceTokenId || undefined,
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transactions"
        subtitle="Track your financial activity"
        primaryAction={{
          label: 'Add Transaction',
          onClick: handleAddTransaction,
          icon: <Plus className="h-4 w-4 mr-2" />,
        }}
      />

      {/* Filters */}
      <Card>
        <CardContent className="p-6">
          <div className="flex space-x-4">
            <div className="flex-1">
              <div className="relative">
                <Search className="h-4 w-4 absolute left-3 top-3 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Search transactions..."
                  className="pl-10 pr-4 py-2 w-full border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>
            <Button variant="outline">
              <Filter className="h-4 w-4 mr-2" />
              Filter
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Transactions List */}
      <Card>
        <CardHeader>
          <CardTitle>All Transactions ({transactions?.length || 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {!transactions || transactions.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-muted-foreground mb-4">No transactions found</div>
              <Button onClick={handleAddTransaction}>
                <Plus className="h-4 w-4 mr-2" />
                Add Your First Transaction
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {transactions.map((transaction) => {
                const holding = holdingsMap[transaction.holdingId];
                const account = holding ? accountsMap[holding.accountId] : null;
                const token = holding ? tokensMap[holding.tokenId] : null;

                return (
                  <div
                    key={transaction.id}
                    className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex items-center space-x-4">
                      <div
                        className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold ${getTransactionColor(
                          transaction.type
                        )}`}
                      >
                        {getTransactionIcon(transaction.type)}
                      </div>
                      <div>
                        <div className="flex items-center space-x-2 mb-1">
                          <p className="font-medium">
                            {transaction.description || `${transaction.type} transaction`}
                          </p>
                          {token && (
                            <div className="flex items-center space-x-1">
                              <div className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center">
                                <span className="text-xs font-medium">{token.symbol}</span>
                              </div>
                              <span className="text-sm text-muted-foreground">{token.name}</span>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center space-x-2 text-sm text-muted-foreground">
                          <span className="capitalize">{transaction.type}</span>
                          <span>•</span>
                          <span>{new Date(transaction.timestamp).toLocaleDateString()}</span>
                          {transaction.price && (
                            <>
                              <span>•</span>
                              <span>Price: ${transaction.price.toFixed(2)}</span>
                            </>
                          )}
                          {transaction.fee > 0 && (
                            <>
                              <span>•</span>
                              <span>Fee: ${transaction.fee.toFixed(2)}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center space-x-3">
                      <div className="text-right">
                        <div className={`font-semibold ${getAmountColor(transaction.type)}`}>
                          {['deposit', 'sell', 'dividend', 'interest'].includes(transaction.type)
                            ? '+'
                            : ['withdrawal', 'buy'].includes(transaction.type)
                              ? '-'
                              : ''}
                          {FinancialMath.formatCurrency(FinancialMath.abs(transaction.amount), {
                            currency: userPrefs?.baseCurrency,
                          })}
                        </div>
                        <div className="text-sm text-muted-foreground space-y-1">
                          <div>{account?.name || 'Unknown Account'}</div>
                          {token && token.type !== 'fiat' && (
                            <div className="capitalize text-xs">
                              {token.type} • {token.symbol}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Action Menu */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleEditTransaction(transaction)}>
                            <Edit2 className="h-4 w-4 mr-2" />
                            Edit Transaction
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleDeleteTransaction(transaction)}
                            className="text-destructive"
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete Transaction
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

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
