import { FinancialMath, type Transaction } from "@scani/shared";
import { CreditCard, Edit2, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  HoldingFilterSelector,
  TransactionTypeSelector,
} from "@/components/selectors/SearchableSelectors";
import { TransactionForm } from "@/components/TransactionForm";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageAggregation } from "@/components/ui/page-aggregation";
import { PageHeader } from "@/components/ui/page-header";
import { ItemCard } from "@/components/ui/summary-cards";
import { useToast } from "@/hooks/use-toast";
import type { ApiAccount, ApiHolding, ApiToken } from "@/lib/api-types";
import { trpc } from "@/lib/trpc";

export function Transactions() {
  const { toast } = useToast();

  const [searchParams, setSearchParams] = useSearchParams();
  const { institutionId, accountId, holdingId } = useParams<{
    institutionId: string;
    accountId: string;
    holdingId: string;
  }>();
  const [isTransactionFormOpen, setIsTransactionFormOpen] = useState(false);
  const [transactionToEdit, setTransactionToEdit] = useState<
    Transaction | undefined
  >();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [transactionToDelete, setTransactionToDelete] = useState<
    Transaction | undefined
  >();
  const [filterByHolding, setFilterByHolding] = useState<string | null>(
    searchParams.get("holding")
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [filterBy, setFilterBy] = useState(searchParams.get("type") || "all");

  const { data: transactions, isLoading } = trpc.transactions.getAll.useQuery();
  const { data: accounts } = trpc.accounts.getAll.useQuery();
  const { data: holdings } = trpc.holdings.getAll.useQuery();
  const { data: tokens } = trpc.tokens.getAll.useQuery();
  const { data: userPrefs } = trpc.users.getCurrent.useQuery();
  const { data: transactionTypes } = trpc.transactionTypes.getAll.useQuery();

  // Determine if we're in hierarchical mode
  const isHierarchicalMode = Boolean(institutionId && accountId && holdingId);

  // Override filterByHolding if we're in hierarchical mode
  const effectiveFilterByHolding = isHierarchicalMode
    ? holdingId
    : filterByHolding;

  const utils = trpc.useUtils();

  // Update filter when URL parameters change
  useEffect(() => {
    const holdingParam = searchParams.get("holding");
    setFilterByHolding(holdingParam);

    // Update transaction type filter from URL
    const typeParam = searchParams.get("type");
    if (typeParam) {
      setFilterBy(typeParam);
    }
  }, [searchParams]);

  // Handler to update filter state and sync with URL
  const handleFilterChange = (newFilter: string) => {
    setFilterBy(newFilter);
    const newSearchParams = new URLSearchParams(searchParams);
    if (newFilter === "all") {
      newSearchParams.delete("type");
    } else {
      newSearchParams.set("type", newFilter);
    }
    setSearchParams(newSearchParams);
  };

  // Handler to update holding filter state and sync with URL
  const handleHoldingFilterChange = (newFilter: string) => {
    const newSearchParams = new URLSearchParams(searchParams);
    if (newFilter === "all") {
      newSearchParams.delete("holding");
      setFilterByHolding(null);
    } else {
      newSearchParams.set("holding", newFilter);
      setFilterByHolding(newFilter);
    }
    setSearchParams(newSearchParams);
  };

  const deleteTransaction = trpc.transactions.delete.useMutation({
    onSuccess: () => {
      toast({
        title: "✅ Transaction deleted",
        description: "The transaction has been successfully deleted.",
      });
      utils.transactions.getAll.invalidate();
      utils.holdings.getAll.invalidate();
      utils.accounts.getAll.invalidate();
      setIsDeleteDialogOpen(false);
      setTransactionToDelete(undefined);
    },
    onError: (error) => {
      toast({
        title: "Error deleting transaction",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Create maps for quick lookups
  const accountsMap = accounts
    ? Object.fromEntries(accounts.map((acc: ApiAccount) => [acc.id, acc]))
    : {};
  const holdingsMap = holdings
    ? Object.fromEntries(
        holdings.map((holding: ApiHolding) => [holding.id, holding])
      )
    : {};
  const tokensMap = tokens
    ? Object.fromEntries(tokens.map((token: ApiToken) => [token.id, token]))
    : {};

  // Filter transactions based on search and filter criteria
  const baseTransactions = transactions || [];

  // Apply holding filter if specified
  const holdingFilteredTransactions = effectiveFilterByHolding
    ? baseTransactions.filter(
        (transaction) => transaction.holdingId === effectiveFilterByHolding
      )
    : baseTransactions;

  // Apply search and type filters
  const filteredTransactions = holdingFilteredTransactions.filter(
    (transaction) => {
      const holding = holdingsMap[transaction.holdingId];
      const account = holding ? accountsMap[holding.accountId] : null;
      const token = holding ? tokensMap[holding.tokenId] : null;

      // Search filter
      const matchesSearch =
        !searchTerm ||
        (transaction.description || "")
          .toLowerCase()
          .includes(searchTerm.toLowerCase()) ||
        transaction.type.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (account?.name || "")
          .toLowerCase()
          .includes(searchTerm.toLowerCase()) ||
        (token?.name || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
        (token?.symbol || "").toLowerCase().includes(searchTerm.toLowerCase());

      // Type filter
      const matchesFilter = filterBy === "all" || transaction.type === filterBy;

      return matchesSearch && matchesFilter;
    }
  );

  // Calculate aggregations in base currency
  const totalValue = filteredTransactions.reduce((sum, transaction) => {
    const baseCurrencyAmount = parseFloat(
      transaction.baseCurrencyAmount || transaction.amount
    );
    const value = ["deposit", "sell", "dividend", "interest"].includes(
      transaction.type
    )
      ? Math.abs(baseCurrencyAmount)
      : ["withdrawal", "buy"].includes(transaction.type)
      ? -Math.abs(baseCurrencyAmount)
      : Math.abs(baseCurrencyAmount);
    return sum + value;
  }, 0);

  const allTransactionsValue = baseTransactions.reduce((sum, transaction) => {
    const baseCurrencyAmount = parseFloat(
      transaction.baseCurrencyAmount || transaction.amount
    );
    const value = ["deposit", "sell", "dividend", "interest"].includes(
      transaction.type
    )
      ? Math.abs(baseCurrencyAmount)
      : ["withdrawal", "buy"].includes(transaction.type)
      ? -Math.abs(baseCurrencyAmount)
      : Math.abs(baseCurrencyAmount);
    return sum + value;
  }, 0);

  const getTransactionIcon = (type: string) => {
    switch (type) {
      case "deposit":
        return "↓";
      case "withdrawal":
        return "↑";
      case "buy":
        return "📈";
      case "sell":
        return "📉";
      case "dividend":
        return "💰";
      case "interest":
        return "💵";
      default:
        return "↔";
    }
  };

  const getTransactionColor = (type: string) => {
    if (["deposit", "sell", "dividend", "interest"].includes(type)) {
      return "bg-green-500";
    } else if (["withdrawal", "buy"].includes(type)) {
      return "bg-red-500";
    }
    return "bg-blue-500";
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Transactions"
          subtitle="Track your financial activity"
          loading={true}
        />
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
      type: transaction.type as Transaction["type"],
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
      type: transaction.type as Transaction["type"],
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
  const pageTitle = filterByHolding
    ? (() => {
        const holdingInfo = holdingsMap[filterByHolding];
        const token = holdingInfo ? tokensMap[holdingInfo.tokenId] : null;
        return `${token?.name || "Holding"} Transactions`;
      })()
    : "Transactions";

  const pageSubtitle = filterByHolding
    ? "Transaction history for this holding"
    : "Track your financial activity";

  return (
    <div className="space-y-4">
      <PageHeader
        title={pageTitle}
        subtitle={pageSubtitle}
        primaryAction={{
          label: "Add Transaction",
          onClick: handleAddTransaction,
          icon: <Plus className="h-4 w-4 mr-1" />,
        }}
        secondaryActions={undefined}
      />

      <PageAggregation
        totalCount={baseTransactions.length}
        filteredCount={filteredTransactions.length}
        entityLabel="transactions"
        totalBalance={filterByHolding ? totalValue : allTransactionsValue}
        filteredBalance={totalValue}
        baseCurrency={userPrefs?.baseCurrency?.symbol}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search by description, type, account, or token..."
        customFilter={
          <div className="flex gap-2">
            <div className="md:w-64">
              <TransactionTypeSelector
                value={filterBy}
                onValueChange={handleFilterChange}
                transactionTypes={[
                  { id: "all", code: "all", name: "All Types" },
                  ...(transactionTypes || []),
                ]}
                placeholder="Filter by type..."
              />
            </div>
            {!filterByHolding && (
              <div className="md:w-64">
                <HoldingFilterSelector
                  value={filterByHolding || "all"}
                  onValueChange={handleHoldingFilterChange}
                  holdings={holdings}
                  tokens={tokens}
                  accounts={accounts}
                  placeholder="Filter by holding..."
                />
              </div>
            )}
          </div>
        }
      />

      {/* Transactions List */}
      {!filteredTransactions || filteredTransactions.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <CreditCard className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <div className="text-muted-foreground mb-4">
              No transactions found
            </div>
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

            const transactionValue = [
              "deposit",
              "sell",
              "dividend",
              "interest",
            ].includes(transaction.type)
              ? FinancialMath.toNumber(FinancialMath.abs(transaction.amount))
              : ["withdrawal", "buy"].includes(transaction.type)
              ? -FinancialMath.toNumber(FinancialMath.abs(transaction.amount))
              : FinancialMath.toNumber(FinancialMath.abs(transaction.amount));

            return (
              <ItemCard
                key={transaction.id}
                title={
                  transaction.description ||
                  `${
                    transaction.type.charAt(0).toUpperCase() +
                    transaction.type.slice(1)
                  } transaction`
                }
                subtitle={
                  <div className="space-y-1">
                    <div className="flex items-center space-x-2 text-xs text-muted-foreground">
                      <span className="capitalize">{transaction.type}</span>
                      <span>•</span>
                      <span>
                        {new Date(transaction.timestamp).toLocaleDateString()}
                      </span>
                      <span>•</span>
                      <span>{account?.name || "Unknown Account"}</span>
                      {token && (
                        <>
                          <span>•</span>
                          <span>{token.symbol}</span>
                        </>
                      )}
                    </div>
                    {parseFloat(transaction.fee) > 0 && (
                      <div className="text-xs text-muted-foreground">
                        Fee:{" "}
                        <span className="inline">
                          {FinancialMath.formatCurrency(
                            parseFloat(transaction.fee),
                            {
                              currency: userPrefs?.baseCurrency?.symbol,
                              style: "currency",
                            }
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                }
                icon={
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold ${getTransactionColor(
                      transaction.type
                    )}`}
                  >
                    {getTransactionIcon(transaction.type)}
                  </div>
                }
                actions={
                  <div className="flex items-center space-x-3">
                    <div className="text-right">
                      <div
                        className={`font-semibold ${
                          transactionValue >= 0
                            ? "text-green-600"
                            : "text-red-600"
                        }`}
                      >
                        {transactionValue >= 0 ? "+" : ""}
                        {FinancialMath.formatCurrency(
                          Math.abs(transactionValue),
                          {
                            currency: token?.symbol,
                            style: "currency",
                          }
                        )}
                      </div>
                      {token?.symbol !== transaction.baseCurrencySymbol && (
                        <div className="text-xs text-muted-foreground">
                          {parseFloat(transaction.baseCurrencyAmount) >= 0
                            ? "+"
                            : ""}
                          {FinancialMath.formatCurrency(
                            Math.abs(
                              parseFloat(transaction.baseCurrencyAmount)
                            ),
                            {
                              currency: transaction.baseCurrencySymbol,
                              style: "currency",
                            }
                          )}
                        </div>
                      )}
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => handleEditTransaction(transaction)}
                        >
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
                }
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
        mode={transactionToEdit ? "edit" : "create"}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Transaction</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this transaction? This action
              cannot be undone and will permanently remove the transaction
              record.
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
              {deleteTransaction.isPending
                ? "Deleting..."
                : "Delete Transaction"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
