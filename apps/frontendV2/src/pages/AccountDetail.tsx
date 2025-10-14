import { Link, useParams } from 'react-router-dom';
import { TokenTypeBadge } from '@/components/features';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { SummaryCard } from '@/components/ui/summary-card';
import { trpc } from '@/lib/trpc';

export function AccountDetail() {
  const { id } = useParams<{ id: string }>();

  // Fetch account data
  const {
    data: account,
    isLoading: accountLoading,
    error: accountError,
  } = trpc.accounts.getById.useQuery({ id: id! }, { enabled: !!id });

  // Fetch holdings for this account
  const { data: allHoldings } = trpc.holdings.getWithDetails.useQuery();
  const accountHoldings = allHoldings?.filter((holding) => holding.account.id === id) || [];

  // Fetch account types and institutions for display
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();
  const { data: institutions } = trpc.institutions.getByUserId.useQuery();

  // Fetch base currency for money display
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const currency = baseCurrency?.symbol || 'USD';

  const accountType = accountTypes?.find((type) => type.id === account?.typeId);
  const institution = institutions?.find((inst) => inst.id === account?.institutionId);

  if (accountLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Loading..." subtitle="Loading account details" />
      </div>
    );
  }

  if (accountError || !account) {
    return (
      <div className="space-y-6">
        <PageHeader title="Account Not Found" subtitle="The requested account could not be found" />
      </div>
    );
  }

  const totalValue = accountHoldings.reduce((sum, holding) => sum + parseFloat(holding.value), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={account.name}
        subtitle={`Account • ${accountType?.name || 'Unknown Type'}`}
      />

      {/* Account Overview */}
      <div className="grid gap-4 md:grid-cols-3">
        <SummaryCard type="currency" title="Total Value" value={totalValue} currency={currency} />

        <SummaryCard
          type="count"
          title="Holdings"
          value={accountHoldings.length}
          label="holdings"
        />

        <Link to={`/institutions/${account.institutionId}`}>
          <SummaryCard
            type="count"
            title="Institution"
            value={1}
            label={institution?.name || 'Unknown'}
          />
        </Link>
      </div>

      {/* Holdings */}
      <Card>
        <CardHeader>
          <CardTitle>Holdings in this Account</CardTitle>
        </CardHeader>
        <CardContent>
          {accountHoldings.length === 0 ? (
            <p className="text-muted-foreground">No holdings in this account yet.</p>
          ) : (
            <div className="space-y-4">
              {accountHoldings.map((holding) => (
                <div
                  key={holding.id}
                  className="flex items-center justify-between border-b pb-4 last:border-b-0 last:pb-0"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                      <span className="text-sm font-medium">
                        {holding.token.symbol.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div>
                      <div className="font-medium">{holding.token.name}</div>
                      <div className="text-sm text-muted-foreground">{holding.token.symbol}</div>
                    </div>
                    <TokenTypeBadge tokenTypeCode={holding.token.typeCode} />
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm">
                      {parseFloat(holding.amount).toLocaleString()} {holding.token.symbol}
                    </div>
                    <div className="font-medium">${parseFloat(holding.value).toLocaleString()}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
