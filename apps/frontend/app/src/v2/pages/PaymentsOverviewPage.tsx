import { formatCurrency, formatDate } from '@scani/shared';
import { EmptyState } from '@scani/ui/components/EmptyState';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { PageLoader } from '@scani/ui/ui/loading';
import { AlertCircle, CalendarClock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { type RouterOutputs, trpc } from '@/lib/trpc';
import { OccurrenceActions } from '../components/payments/OccurrenceActions';
import { sumAmountsByCurrency, todayDateString } from '../lib/paymentTotals';
import { V2_ROUTES } from '../lib/routes';

type UpcomingOccurrence = RouterOutputs['payments']['upcoming'][number];

const HORIZON_DAYS = 30;

/**
 * The payments home screen. Detection was dropped — there is no
 * "proposals" surface — so this is a plain due-date feed of the
 * occurrences the recurrence engine already materialised, with inline
 * settlement (`OccurrenceActions`) on every row since that's the primary
 * way an occurrence resolves.
 */
export function PaymentsOverviewPage() {
  const { data: occurrences, isLoading: occurrencesLoading } = trpc.payments.upcoming.useQuery({
    days: HORIZON_DAYS,
  });
  const { data: vendors, isLoading: vendorsLoading } = trpc.vendors.list.useQuery();
  const { data: tokens, isLoading: tokensLoading } = trpc.tokens.getAll.useQuery();

  if (occurrencesLoading || vendorsLoading || tokensLoading) return <PageLoader />;

  const vendorNameById = new Map((vendors ?? []).map((v) => [v.id, v.displayName]));
  const tokenSymbolById = new Map((tokens ?? []).map((t) => [t.id, t.symbol]));
  const items = occurrences ?? [];

  if (items.length === 0) {
    return (
      <div className="space-y-6">
        <EmptyState
          icon={CalendarClock}
          title={`No upcoming payments in the next ${HORIZON_DAYS} days`}
          action={
            <Button asChild variant="outline" size="sm">
              <Link to={V2_ROUTES.paymentsList}>View all recurring payments</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const today = todayDateString();
  const overdue = items.filter((o) => o.dueDate < today);
  const upcoming = items.filter((o) => o.dueDate >= today);

  // Only outflow occurrences due within the window count toward "committed
  // outflow" — a raw sum of actual dated occurrences, not an annualised
  // projection, since every one of these is a real dated instance already.
  const outflowTotals = sumAmountsByCurrency(
    items
      .filter((o) => o.payment.direction === 'outflow')
      .map((o) => ({
        amount: o.actualAmount ?? o.expectedAmount ?? '0',
        currencyTokenId: o.payment.currencyTokenId,
      }))
  );

  const groupedByDate = new Map<string, UpcomingOccurrence[]>();
  for (const occurrence of upcoming) {
    const bucket = groupedByDate.get(occurrence.dueDate) ?? [];
    bucket.push(occurrence);
    groupedByDate.set(occurrence.dueDate, bucket);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Payments</h2>
        <p className="text-muted-foreground mt-1">
          Committed outflow, next {HORIZON_DAYS} days:{' '}
          {outflowTotals.size === 0
            ? formatCurrency(0, 'USD')
            : Array.from(outflowTotals.entries())
                .map(([tokenId, total]) =>
                  formatCurrency(total.toString(), tokenSymbolById.get(tokenId) ?? 'USD')
                )
                .join(' + ')}
        </p>
      </div>

      {overdue.length > 0 && (
        <OccurrenceGroupCard
          title="Overdue"
          accent="warning"
          showDueDate
          occurrences={overdue}
          vendorNameById={vendorNameById}
          tokenSymbolById={tokenSymbolById}
        />
      )}

      {Array.from(groupedByDate.entries()).map(([dueDate, dateOccurrences]) => (
        <OccurrenceGroupCard
          key={dueDate}
          title={formatDate(dueDate)}
          occurrences={dateOccurrences}
          vendorNameById={vendorNameById}
          tokenSymbolById={tokenSymbolById}
        />
      ))}
    </div>
  );
}

function OccurrenceGroupCard({
  title,
  accent,
  occurrences,
  vendorNameById,
  tokenSymbolById,
  showDueDate = false,
}: {
  title: string;
  accent?: 'warning';
  occurrences: UpcomingOccurrence[];
  vendorNameById: Map<string, string>;
  tokenSymbolById: Map<string, string>;
  /**
   * Date-grouped cards carry the date in their heading; the Overdue card
   * spans many dates, so without this every row reads identically —
   * eighteen "Flare (salary) · Incoming · £2,400.00" lines with nothing
   * to say which fortnight is which.
   */
  showDueDate?: boolean;
}) {
  return (
    <Card className={accent === 'warning' ? 'border-amber-500/50 bg-amber-500/5' : undefined}>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-1.5">
          {accent === 'warning' && <AlertCircle className="h-3.5 w-3.5 text-amber-600" />}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-y">
        {occurrences.map((occurrence) => {
          const symbol = tokenSymbolById.get(occurrence.payment.currencyTokenId) ?? 'USD';
          return (
            <div
              key={occurrence.id}
              className="flex flex-wrap items-center justify-between gap-3 py-2.5"
            >
              <div className="min-w-0">
                <Link
                  to={V2_ROUTES.paymentDetail(occurrence.payment.id)}
                  className="text-sm font-medium hover:underline block truncate"
                >
                  {vendorNameById.get(occurrence.payment.vendorId) ?? 'Unknown vendor'}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {showDueDate && `${formatDate(occurrence.dueDate)} · `}
                  {occurrence.payment.direction === 'inflow' ? 'Incoming' : 'Outgoing'}
                  {occurrence.expectedAmount &&
                    ` · ${formatCurrency(occurrence.expectedAmount, symbol)}`}
                </p>
              </div>
              <OccurrenceActions
                occurrenceId={occurrence.id}
                expectedAmount={occurrence.expectedAmount}
                direction={occurrence.payment.direction === 'inflow' ? 'inflow' : 'outflow'}
              />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
