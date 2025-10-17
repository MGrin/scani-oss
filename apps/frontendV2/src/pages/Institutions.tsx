import { Building2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MoneyDisplay } from '@/components/ui/money-display';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

export function Institutions() {
  // Fetch institutions with summary data
  const { data: institutions, isLoading } = trpc.institutions.getByUserIdWithSummary.useQuery();

  // Fetch institution types for display
  const { data: institutionTypes } = trpc.institutionTypes.getAll.useQuery();

  // Fetch base currency for money display
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const currency = baseCurrency?.symbol || 'USD';
  const baseCurrencyToken = createCurrencyToken(currency);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Institutions" subtitle="Your financial institutions" />
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((num) => (
            <Card key={`skeleton-${num}`} className="min-h-[160px]">
              <CardHeader>
                <Skeleton className="h-6 w-32" />
                <Skeleton className="h-4 w-20" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-24 mb-2" />
                <Skeleton className="h-4 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Institutions" subtitle="Your financial institutions" />

      {institutions && institutions.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No institutions yet</h3>
            <p className="text-muted-foreground text-center mb-4">
              Add your first financial institution to start tracking your accounts and holdings.
            </p>
            <button
              type="button"
              className="bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90"
            >
              Add Institution
            </button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {institutions?.map((institution) => {
            const institutionType = institutionTypes?.find(
              (type) => type.id === institution.typeId
            );

            return (
              <Link key={institution.id} to={`/institutions/${institution.id}`}>
                <Card className="hover:shadow-md transition-shadow cursor-pointer min-h-[160px]">
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                      <span className="truncate">{institution.name}</span>
                      <div className="text-sm text-muted-foreground ml-2">
                        {institutionType?.name || 'Unknown'}
                      </div>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div>
                        <p className="text-sm text-muted-foreground">Total Value</p>
                        <div className="text-xl font-semibold">
                          <MoneyDisplay
                            value={institution.summary.totalValue}
                            token={baseCurrencyToken}
                          />
                        </div>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">
                          {institution.summary.accountCount} account
                          {institution.summary.accountCount !== 1 ? 's' : ''}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
