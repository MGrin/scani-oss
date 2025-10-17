import { Link, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MoneyDisplay } from '@/components/ui/money-display';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { SummaryCard } from '@/components/ui/summary-card';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

export function InstitutionDetail() {
  const { id } = useParams<{ id: string }>();

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
    allHoldings?.filter((holding) =>
      institutionAccounts.some((account) => account.id === holding.account.id)
    ) || [];

  // Fetch account types and institution types for display
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();
  const { data: institutionTypes } = trpc.institutionTypes.getAll.useQuery();

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
      (holding) => holding.account.id === account.id
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
          value={institutionHoldings.length}
          label="holdings"
        />
      </div>

      {/* Accounts within this Institution */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Accounts</h2>
        {institutionAccounts.length === 0 ? (
          <p className="text-muted-foreground">No accounts in this institution yet.</p>
        ) : (
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
            {institutionAccounts.map((account) => {
              const accountHoldings = institutionHoldings.filter(
                (holding) => holding.account.id === account.id
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
    </div>
  );
}
