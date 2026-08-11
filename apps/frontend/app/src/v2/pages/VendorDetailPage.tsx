import { formatCurrency } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { PageLoader } from '@scani/ui/ui/loading';
import { ArrowLeft, GitMerge } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { VendorMergeDialog } from '../components/payments/VendorMergeDialog';
import {
  asPaymentIntervalUnit,
  formatPaymentInterval,
  sumMonthlyEquivalentByCurrency,
} from '../lib/paymentTotals';
import { V2_ROUTES } from '../lib/routes';

export function VendorDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [mergeOpen, setMergeOpen] = useState(false);

  const vendorQuery = trpc.vendors.get.useQuery({ vendorId: id }, { enabled: Boolean(id) });
  const { data: vendors, isLoading: vendorsLoading } = trpc.vendors.list.useQuery();
  const { data: payments, isLoading: paymentsLoading } = trpc.payments.list.useQuery();
  const { data: tokens, isLoading: tokensLoading } = trpc.tokens.getAll.useQuery();

  if (!id) return null;
  if (vendorQuery.isLoading || vendorsLoading || paymentsLoading || tokensLoading) {
    return <PageLoader />;
  }
  if (vendorQuery.error || !vendorQuery.data) {
    return (
      <div className="max-w-2xl space-y-6">
        <BackLink />
        <p className="text-sm text-destructive">Vendor not found.</p>
      </div>
    );
  }

  const vendor = vendorQuery.data;
  const tokenSymbolById = new Map((tokens ?? []).map((t) => [t.id, t.symbol]));
  const vendorPayments = (payments ?? []).filter((p) => p.vendorId === vendor.id);
  const activeOutflowPayments = vendorPayments.filter(
    (p) => p.status === 'active' && p.direction === 'outflow'
  );
  const monthlySpendByCurrency = sumMonthlyEquivalentByCurrency(
    activeOutflowPayments.map((p) => ({
      expectedAmount: p.expectedAmount,
      intervalUnit: asPaymentIntervalUnit(p.intervalUnit),
      intervalCount: p.intervalCount,
      currencyTokenId: p.currencyTokenId,
    }))
  );

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <BackLink />
        <Button variant="outline" size="sm" onClick={() => setMergeOpen(true)}>
          <GitMerge className="h-4 w-4 mr-1" />
          Merge duplicate
        </Button>
      </div>

      <div>
        <h2 className="text-2xl font-bold tracking-tight">{vendor.displayName}</h2>
        {vendor.category && <p className="text-sm text-muted-foreground mt-1">{vendor.category}</p>}
      </div>

      {monthlySpendByCurrency.size > 0 && (
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground mb-1">
              Approx. monthly spend across {activeOutflowPayments.length} active payment
              {activeOutflowPayments.length === 1 ? '' : 's'}
            </p>
            <p className="text-2xl font-bold tabular-nums">
              {Array.from(monthlySpendByCurrency.entries())
                .map(([tokenId, total]) =>
                  formatCurrency(total.toString(), tokenSymbolById.get(tokenId) ?? 'USD')
                )
                .join(' + ')}
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Spend history ({vendorPayments.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {vendorPayments.length === 0 ? (
            <p className="text-xs text-muted-foreground">No payments recorded for this vendor.</p>
          ) : (
            <div className="divide-y">
              {vendorPayments.map((payment) => {
                const symbol = tokenSymbolById.get(payment.currencyTokenId) ?? 'USD';
                return (
                  <Link
                    key={payment.id}
                    to={V2_ROUTES.paymentDetail(payment.id)}
                    className="flex items-center justify-between gap-3 py-2.5 hover:bg-accent/50 -mx-2 px-2 rounded-md"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">
                          {formatPaymentInterval(
                            asPaymentIntervalUnit(payment.intervalUnit),
                            payment.intervalCount
                          )}
                        </span>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 capitalize">
                          {payment.status}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {payment.direction === 'inflow' ? 'Income' : 'Bill'}
                      </p>
                    </div>
                    <span className="text-sm font-semibold tabular-nums shrink-0">
                      {payment.expectedAmount
                        ? formatCurrency(payment.expectedAmount, symbol)
                        : '—'}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Aliases</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Alias history (bank-statement counterparty strings and document names folded into this
            vendor) isn't exposed by the API yet — merges still work below.
          </p>
        </CardContent>
      </Card>

      <VendorMergeDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        vendor={vendor}
        vendors={vendors ?? []}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Button variant="ghost" size="sm" asChild className="h-7 gap-1 -ml-2">
      <Link to={V2_ROUTES.vendors}>
        <ArrowLeft className="h-3.5 w-3.5" />
        All vendors
      </Link>
    </Button>
  );
}
