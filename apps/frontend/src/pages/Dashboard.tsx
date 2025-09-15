import { FinancialMath, type Holding } from "@scani/shared";
import {
  BarChart3,
  DollarSign,
  Plus,
  TrendingDown,
  TrendingUp,
  Wallet,
  Zap,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { TransactionForm } from "@/components/TransactionForm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ColoredMonetaryValue,
  MonetaryValue,
} from "@/components/ui/monetary-value";
import { PageHeader } from "@/components/ui/page-header";
import { SummaryCard } from "@/components/ui/summary-cards";
import type { WebSocketMessage } from "@/hooks/useWebSocket";
import { useScaniWebSocket } from "@/hooks/useWebSocket";
import type { ApiHolding, ApiToken } from "@/lib/api-types";
import { getTokenTypeIcon } from "@/lib/icons";
import { trpc } from "@/lib/trpc";

export function Dashboard() {
  const navigate = useNavigate();

  // State for Quick Actions modals
  const [isTransactionFormOpen, setIsTransactionFormOpen] = useState(false);

  const { data: accounts, isLoading: accountsLoading } =
    trpc.accounts.getAll.useQuery();
  const { data: holdings, isLoading: holdingsLoading } =
    trpc.holdings.getAll.useQuery();
  const { data: transactions, isLoading: transactionsLoading } =
    trpc.transactions.getAll.useQuery();
  const { data: tokens } = trpc.tokens.getAll.useQuery();
  const { data: userPrefs } = trpc.users.getCurrent.useQuery();
  const { data: portfolioValue, isLoading: portfolioLoading } =
    trpc.users.getPortfolioValue.useQuery();
  const { data: monthlySummary, isLoading: monthlySummaryLoading } =
    trpc.transactions.getMonthlySummary.useQuery({});

  const handleWebSocketMessage = useCallback((message: WebSocketMessage) => {
    console.log("Received WebSocket message:", message);
    // Handle real-time updates here if needed
  }, []);

  const { isConnected, connectionStatus } = useScaniWebSocket({
    url: "ws://localhost:3002",
    onMessage: handleWebSocketMessage,
  });

  // Create maps for quick lookups
  const tokensMap = tokens
    ? Object.fromEntries(tokens.map((token: ApiToken) => [token.id, token]))
    : {};

  // Use portfolio value calculation instead of raw balance
  const totalHoldingsValue = portfolioValue
    ? parseFloat(portfolioValue.totalValue.toString())
    : 0;

  // Calculate holdings by token type
  interface TokenTypeData {
    count: number;
    totalValue: number;
    holdings: Holding[];
  }

  const holdingsByTokenType =
    holdings && portfolioValue
      ? holdings.reduce(
          (acc: Record<string, TokenTypeData>, holding: ApiHolding) => {
            const token = tokensMap[holding.tokenId];
            if (!token) return acc;

            const tokenType = token.type ?? "unknown";
            if (!acc[tokenType]) {
              acc[tokenType] = {
                count: 0,
                totalValue: 0,
                holdings: [],
              };
            }

            // Try to find the portfolio value for this holding's token
            const portfolioHolding = portfolioValue.holdings.find(
              (ph) => ph.tokenSymbol === token.symbol
            );

            const holdingValue = portfolioHolding?.value
              ? parseFloat(portfolioHolding.value)
              : FinancialMath.toNumber(FinancialMath.abs(holding.balance ?? 0)); // fallback to raw balance

            acc[tokenType].count += 1;
            acc[tokenType].totalValue = FinancialMath.toNumber(
              FinancialMath.add(acc[tokenType].totalValue, holdingValue)
            );
            acc[tokenType].holdings.push(holding as unknown as Holding);

            return acc;
          },
          {}
        )
      : {};

  // Get top 5 holdings by value using portfolio calculation
  const topHoldings =
    holdings && portfolioValue
      ? [...holdings]
          .map((holding) => {
            const token = tokensMap[holding.tokenId];
            // Try to find the portfolio value for this holding's token
            const portfolioHolding = portfolioValue.holdings.find(
              (ph) => ph.tokenSymbol === token?.symbol
            );

            return {
              ...holding,
              token,
              value: portfolioHolding?.value
                ? parseFloat(portfolioHolding.value)
                : FinancialMath.toNumber(FinancialMath.abs(holding.balance)), // fallback to raw balance
            };
          })
          .sort((a, b) => b.value - a.value)
          .slice(0, 5)
      : [];

  const recentTransactions = transactions?.slice(0, 5) || [];

  // Use backend-calculated monthly summaries (now properly converted to base currency)
  const monthlyDeposits = monthlySummary?.totalDeposits ?? 0;
  const monthlyWithdrawals = monthlySummary?.totalWithdrawals ?? 0;

  if (
    transactionsLoading ||
    accountsLoading ||
    holdingsLoading ||
    portfolioLoading ||
    monthlySummaryLoading ||
    !tokens
  ) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Dashboard"
          subtitle="Your financial overview"
          loading={true}
          secondaryActions={
            <div className="text-sm text-muted-foreground">
              WebSocket: {connectionStatus}
            </div>
          }
        />

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  Loading...
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-6 bg-muted animate-pulse rounded"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dashboard"
        subtitle="Your financial overview"
        secondaryActions={
          <div className="flex items-center space-x-1.5">
            <div
              className={`h-1.5 w-1.5 rounded-full ${
                isConnected ? "bg-green-500" : "bg-red-500"
              }`}
            />
            <span className="text-sm text-muted-foreground">
              {isConnected ? "Live" : "Offline"}
            </span>
          </div>
        }
      />

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          type="currency"
          title="Total Balance"
          value={totalHoldingsValue}
          currency={userPrefs?.baseCurrency?.symbol}
          subtitle={`Across ${holdings?.length || 0} holdings in ${
            accounts?.length || 0
          } accounts`}
          icon={Wallet}
        />

        <SummaryCard
          type="currency"
          title="Monthly Deposits"
          value={monthlyDeposits}
          currency={userPrefs?.baseCurrency?.symbol}
          subtitle="This month"
          icon={TrendingUp}
          className="[&_.value]:text-green-600"
        />

        <SummaryCard
          type="currency"
          title="Monthly Withdrawals"
          value={monthlyWithdrawals}
          currency={userPrefs?.baseCurrency?.symbol}
          subtitle="This month"
          icon={TrendingDown}
          className="[&_.value]:text-red-600"
        />

        <SummaryCard
          type="currency"
          title="Net Flow"
          value={FinancialMath.toNumber(
            FinancialMath.subtract(monthlyDeposits, monthlyWithdrawals)
          )}
          currency={userPrefs?.baseCurrency?.symbol}
          subtitle="This month"
          icon={DollarSign}
          showSigned={true}
        />
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Plus className="h-5 w-5" />
            <span>Quick Actions</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
          <Button
            onClick={() => navigate("/quick-add-holding")}
            className="flex items-center justify-center space-x-2 h-10"
          >
            <Zap className="h-5 w-5" />
            <span>Add Holding</span>
          </Button>
          <Button
            variant="outline"
            onClick={() => setIsTransactionFormOpen(true)}
            className="flex items-center justify-center space-x-2 h-10"
          >
            <DollarSign className="h-5 w-5" />
            <span>Add Transaction</span>
          </Button>
          <Button
            variant="outline"
            onClick={() => navigate("/quick-add-holding")}
            className="flex items-center justify-center space-x-2 h-10"
          >
            <Wallet className="h-5 w-5" />
            <span>Add Holding</span>
          </Button>
          <Button
            variant="outline"
            onClick={() => navigate("/analytics")}
            className="flex items-center justify-center space-x-2 h-10"
          >
            <BarChart3 className="h-5 w-5" />
            <span>View Analytics</span>
          </Button>
        </CardContent>
      </Card>

      {/* Holdings Overview */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Holdings by Token Type */}
        <Card>
          <CardHeader>
            <CardTitle>Holdings by Type</CardTitle>
          </CardHeader>
          <CardContent>
            {Object.keys(holdingsByTokenType).length === 0 ? (
              <div className="text-center py-6 text-muted-foreground">
                No holdings found
              </div>
            ) : (
              <div className="space-y-3">
                {Object.entries(holdingsByTokenType)
                  .sort(
                    ([, a], [, b]) =>
                      (b as TokenTypeData).totalValue -
                      (a as TokenTypeData).totalValue
                  )
                  .map(([tokenType, data]) => {
                    const tokenData = data as TokenTypeData;
                    const IconComponent = getTokenTypeIcon(tokenType);

                    return (
                      <button
                        key={tokenType}
                        type="button"
                        className="w-full flex items-center justify-between p-3 bg-muted/30 rounded-lg hover:bg-muted/50 cursor-pointer transition-colors text-left"
                        onClick={() =>
                          navigate(
                            `/holdings?type=${encodeURIComponent(tokenType)}`
                          )
                        }
                      >
                        <div className="flex items-center space-x-3">
                          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                            <IconComponent className="h-5 w-5" />
                          </div>
                          <div>
                            <p className="font-medium capitalize">
                              {tokenType}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {tokenData.count} holdings
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <MonetaryValue
                            type="currency"
                            value={tokenData.totalValue}
                            currency={userPrefs?.baseCurrency?.symbol}
                            className="font-semibold"
                          />
                          <p className="text-sm text-muted-foreground">
                            {(
                              (tokenData.totalValue / totalHoldingsValue) *
                              100
                            ).toFixed(1)}
                            %
                          </p>
                        </div>
                      </button>
                    );
                  })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top Holdings */}
        <Card>
          <CardHeader>
            <CardTitle>Top Holdings</CardTitle>
          </CardHeader>
          <CardContent>
            {topHoldings.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground">
                No holdings found
              </div>
            ) : (
              <div className="space-y-3">
                {topHoldings.map((holding, index: number) => (
                  <button
                    key={holding.id}
                    type="button"
                    className="w-full flex items-center justify-between p-3 bg-muted/30 rounded-lg hover:bg-muted/50 cursor-pointer transition-colors text-left"
                    onClick={() => {
                      const account = accounts?.find(
                        (acc) => acc.id === holding.accountId
                      );
                      if (account) {
                        navigate(
                          `/institutions/${account.institutionId}/accounts/${account.id}/holdings/${holding.id}`
                        );
                      } else {
                        // Fallback to old route if account not found
                        navigate(
                          `/transactions?holding=${encodeURIComponent(
                            holding.id
                          )}`
                        );
                      }
                    }}
                  >
                    <div className="flex items-center space-x-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                        <span className="text-xs font-medium">
                          {holding.token?.symbol || "?"}
                        </span>
                      </div>
                      <div>
                        <p className="font-medium text-sm">
                          {holding.token?.name || "Unknown Token"}
                        </p>
                        <div className="flex items-center space-x-1 text-xs text-muted-foreground">
                          <span className="capitalize">
                            {holding.token?.type}
                          </span>
                          <span>•</span>
                          <span>#{index + 1}</span>
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <MonetaryValue
                        type="currency"
                        value={holding.value}
                        currency={userPrefs?.baseCurrency?.symbol}
                        className="font-semibold"
                      />
                      <MonetaryValue
                        type="token"
                        value={parseFloat(holding.balance)}
                        tokenSymbol={holding.token?.symbol || ""}
                        decimals={holding.token?.decimals || 2}
                        size="xs"
                        className="text-muted-foreground block"
                      />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Recent Transactions</CardTitle>
        </CardHeader>
        <CardContent>
          {recentTransactions.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">
              No transactions yet. Create your first transaction to get started.
            </div>
          ) : (
            <div className="space-y-4">
              {recentTransactions.map((transaction) => (
                <div
                  key={transaction.id}
                  className="flex items-center justify-between"
                >
                  <div>
                    <p className="font-medium">
                      {transaction.description ||
                        `${transaction.type} transaction`}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {transaction.type} •{" "}
                      {new Date(transaction.timestamp).toLocaleDateString()}
                      {parseFloat(transaction.fee) > 0 && (
                        <>
                          {" • Fee: "}
                          <MonetaryValue
                            type="currency"
                            value={parseFloat(transaction.fee)}
                            currency={userPrefs?.baseCurrency?.symbol}
                            size="sm"
                            className="inline"
                          />
                        </>
                      )}
                    </p>
                  </div>
                  <ColoredMonetaryValue
                    type="currency"
                    value={
                      ["deposit", "sell", "dividend", "interest"].includes(
                        transaction.type
                      )
                        ? FinancialMath.toNumber(
                            FinancialMath.abs(transaction.amount)
                          )
                        : -FinancialMath.toNumber(
                            FinancialMath.abs(transaction.amount)
                          )
                    }
                    currency={userPrefs?.baseCurrency?.symbol}
                    className="font-semibold"
                    showSign={true}
                  />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <TransactionForm
        isOpen={isTransactionFormOpen}
        onClose={() => setIsTransactionFormOpen(false)}
        mode="create"
      />
    </div>
  );
}
