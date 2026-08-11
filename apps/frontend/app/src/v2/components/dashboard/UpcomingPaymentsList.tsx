import { formatCurrency, formatDate } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { CalendarClock } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { RouterOutputs } from '@/lib/trpc';
import { sumAmountsByCurrency, todayDateString } from '../../lib/paymentTotals';
import { V2_ROUTES } from '../../lib/routes';

type UpcomingOccurrence = RouterOutputs['payments']['upcoming'][number];

const MAX_ROWS = 5;

interface UpcomingPaymentsListProps {
  occurrences: UpcomingOccurrence[];
  vendorNameById: Map<string, string>;
  tokenSymbolById: Map<string, string>;
  horizonDays: number;
}

/**
 * Dashboard-facing slice of the payments layer — the committed 30-day
 * outflow figure plus the next few occurrences due, both linking back to
 * `/payments`. Shares `sumAmountsByCurrency` with `PaymentsOverviewPage`
 * so the two "committed outflow" figures can never drift.
 */
export function UpcomingPaymentsList({
  occurrences,
  vendorNameById,
  tokenSymbolById,
  horizonDays,
}: UpcomingPaymentsListProps) {
  // `payments.upcoming` returns overdue occurrences too — the overview
  // page splits them into its own section. A card headed "next N days"
  // has to do the same, or it lists January's bills under August's
  // heading.
  const today = todayDateString();
  const dueAhead = occurrences.filter((o) => o.dueDate >= today);
  const overdueCount = occurrences.length - dueAhead.length;

  const outflowTotals = sumAmountsByCurrency(
    dueAhead
      .filter((o) => o.payment.direction === 'outflow')
      .map((o) => ({
        amount: o.actualAmount ?? o.expectedAmount ?? '0',
        currencyTokenId: o.payment.currencyTokenId,
      }))
  );

  const nextOccurrences = [...dueAhead]
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, MAX_ROWS);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4" />
            Payments
          </CardTitle>
          <Link
            to={V2_ROUTES.payments}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            View all
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">
          Committed outflow, next {horizonDays} days:{' '}
          {outflowTotals.size === 0
            ? formatCurrency(0, 'USD')
            : Array.from(outflowTotals.entries())
                .map(([tokenId, total]) =>
                  formatCurrency(total.toString(), tokenSymbolById.get(tokenId) ?? 'USD')
                )
                .join(' + ')}
        </p>
        {overdueCount > 0 && (
          <Link
            to={V2_ROUTES.payments}
            className="text-xs font-medium text-amber-600 hover:underline dark:text-amber-400"
          >
            {overdueCount} overdue
          </Link>
        )}
      </CardHeader>
      <CardContent>
        {nextOccurrences.length === 0 ? (
          <div className="text-center py-4">
            <p className="text-sm text-muted-foreground">No upcoming payments</p>
            <Button asChild variant="outline" size="sm" className="mt-3">
              <Link to={V2_ROUTES.paymentCreate}>Add a payment</Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-1">
            {nextOccurrences.map((occurrence) => {
              const symbol = tokenSymbolById.get(occurrence.payment.currencyTokenId) ?? 'USD';
              return (
                <Link
                  key={occurrence.id}
                  to={V2_ROUTES.paymentDetail(occurrence.payment.id)}
                  className="flex items-center justify-between -mx-2 px-2 py-1.5 rounded-md hover:bg-accent/50 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {vendorNameById.get(occurrence.payment.vendorId) ?? 'Unknown vendor'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(occurrence.dueDate)}
                      {occurrence.payment.direction === 'inflow' ? ' · Incoming' : ' · Outgoing'}
                    </p>
                  </div>
                  <p className="text-sm font-medium tabular-nums ml-4 shrink-0">
                    {occurrence.expectedAmount
                      ? formatCurrency(occurrence.expectedAmount, symbol)
                      : '—'}
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
