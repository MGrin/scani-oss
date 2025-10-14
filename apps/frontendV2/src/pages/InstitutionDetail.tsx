import { Link, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { SummaryCard } from '@/components/ui/summary-card';
import { trpc } from '@/lib/trpc';

export function InstitutionDetail() {
  const { id } = useParams<{ id: string }>();

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

  // Fetch base currency for money display
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const currency = baseCurrency?.symbol || 'USD';

  if (institutionLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Loading..." subtitle="Loading institution details" />
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
    return sum + accountHoldings.reduce((accSum, holding) => accSum + parseFloat(holding.value), 0);
  }, 0);

  const institutionType = institutionTypes?.find((type) => type.id === institution.typeId);

  return (
    <div className="space-y-6">
      <PageHeader
        title={institution.name}
        subtitle={`Institution • ${institutionType?.name || 'Unknown Type'}`}
      />

      {/* Institution Summary */}
      <div className="grid gap-4 md:grid-cols-3">
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
          <div className="grid gap-4 md:grid-cols-2">
            {institutionAccounts.map((account) => {
              const accountHoldings = institutionHoldings.filter(
                (holding) => holding.account.id === account.id
              );
              const accountValue = accountHoldings.reduce(
                (sum, holding) => sum + parseFloat(holding.value),
                0
              );
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
                      <div className="text-lg font-semibold">${accountValue.toLocaleString()}</div>
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
