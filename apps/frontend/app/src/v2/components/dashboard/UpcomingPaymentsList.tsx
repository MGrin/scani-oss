import { formatCurrency, formatDate } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { CalendarClock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useBaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import type { RouterOutputs } from '@/lib/trpc';
import {
  convertAmountToBase,
  convertTotalsToBase,
  describeConversion,
  sumAmountsByCurrency,
  todayDateString,
} from '../../lib/paymentTotals';
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
 * outflow figure plus the next few bills due, both linking back to
 * `/payments`. Shares `sumAmountsByCurrency` + `convertTotalsToBase` with
 * `PaymentsOverviewPage` so the two "committed outflow" figures can never
 * drift, in the base currency or in the rates behind it.
 *
 * V3-47: the figure had always been filtered to outflow and the list
 * beneath it had not, so an income invoice appeared as a row under a
 * heading that described bills and was absent from the total the reader
 * checked it against. The list is now outflow too, and income gets a
 * figure of its own — converted the same way, and never subtracted from
 * the outflow one.
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
  // Bills only, like the list: an income invoice that has not landed yet is
  // not something the reader is late on.
  const overdueCount = occurrences.filter(
    (o) => o.dueDate < today && o.payment.direction === 'outflow'
  ).length;

  const billsAhead = dueAhead.filter((o) => o.payment.direction === 'outflow');
  const incomeAhead = dueAhead.filter((o) => o.payment.direction === 'inflow');

  const toAmounts = (occurrences: UpcomingOccurrence[]) =>
    occurrences.map((o) => ({
      amount: o.actualAmount ?? o.expectedAmount ?? '0',
      currencyTokenId: o.payment.currencyTokenId,
    }));

  const symbolFor = (tokenId: string) => tokenSymbolById.get(tokenId) ?? rates.baseSymbol;

  // One rate set, both figures. Income has to convert for the same reason the
  // outflow figure did — "180 GBP and in small plus 300 USD" is not a forecast
  // anyone can plan against — so it goes through `convertTotalsToBase` too
  // rather than being printed as the per-currency list this replaced.
  const rates = useBaseCurrencyRates(dueAhead.map((o) => o.payment.currencyTokenId));
  const committed = convertTotalsToBase(sumAmountsByCurrency(toAmounts(billsAhead)), rates);
  const expectedIncome = convertTotalsToBase(sumAmountsByCurrency(toAmounts(incomeAhead)), rates);
  const conversionNote = describeConversion(committed, symbolFor);
  const incomeNote = describeConversion(expectedIncome, symbolFor);

  const nextOccurrences = [...billsAhead]
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
          {formatCurrency(committed.amount.toString(), rates.baseSymbol)}
        </p>
        {conversionNote && <p className="text-xs text-muted-foreground">{conversionNote}</p>}
        {/* A separate claim, never subtracted from the one above: a bill is an
            obligation and income is a forecast, and one net figure would
            average the two as if they were equally certain. */}
        {incomeAhead.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              Expected income, next {horizonDays} days:{' '}
              {formatCurrency(expectedIncome.amount.toString(), rates.baseSymbol)}
            </p>
            {incomeNote && <p className="text-xs text-muted-foreground">{incomeNote}</p>}
          </>
        )}
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
            <p className="text-sm text-muted-foreground">No bills due</p>
            <Button asChild variant="outline" size="sm" className="mt-3">
              <Link to={V2_ROUTES.paymentCreate}>Add a payment</Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-1">
            {nextOccurrences.map((occurrence) => {
              const symbol = tokenSymbolById.get(occurrence.payment.currencyTokenId) ?? 'USD';
              const equivalent = convertAmountToBase(
                occurrence.expectedAmount,
                occurrence.payment.currencyTokenId,
                rates
              );
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
                    {/* No direction suffix any more: every row here is a bill,
                        and the figure above the list says so. */}
                    <p className="text-xs text-muted-foreground">
                      {formatDate(occurrence.dueDate)}
                    </p>
                  </div>
                  <div className="ml-4 shrink-0 text-right">
                    <p className="text-sm font-medium tabular-nums">
                      {occurrence.expectedAmount
                        ? formatCurrency(occurrence.expectedAmount, symbol)
                        : '—'}
                    </p>
                    {equivalent && (
                      <p className="text-xs text-muted-foreground tabular-nums">
                        ≈ {formatCurrency(equivalent.amount.toString(), rates.baseSymbol)}
                      </p>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
