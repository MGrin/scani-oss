import { formatCurrency, formatDate } from '@scani/shared';
import { ConfirmDialog } from '@scani/ui/components/ConfirmDialog';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { PageLoader } from '@scani/ui/ui/loading';
import { Separator } from '@scani/ui/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { ArrowLeft, FileText, Pause, Pencil, Receipt, StopCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { type RouterOutputs, trpc } from '@/lib/trpc';
import { OccurrenceActions } from '../components/payments/OccurrenceActions';
import {
  asPaymentIntervalUnit,
  formatOccurrenceStatus,
  formatPaymentInterval,
  monthlyEquivalent,
  todayDateString,
} from '../lib/paymentTotals';
import { V2_ROUTES } from '../lib/routes';

const OCCURRENCE_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  scheduled: 'outline',
  matched: 'default',
  skipped: 'secondary',
  missed: 'secondary',
};

/** Upcoming rows shown before the "show all" toggle. */
const UPCOMING_PREVIEW = 6;

type PaymentDetail = RouterOutputs['payments']['get'];
type Occurrence = PaymentDetail['occurrences'][number];

/**
 * One occurrence table, rendered once per section.
 *
 * Occurrences are materialised a year ahead, so a single newest-first
 * list opened on a date ~11 months out with the next actionable row two
 * dozen rows down. Upcoming and past are separate questions — "what do I
 * owe next" and "what happened" — and get separate sections, ordered so
 * each one leads with the row nearest today.
 */
function OccurrenceTable({
  occurrences,
  direction,
  currencySymbol,
}: {
  occurrences: Occurrence[];
  direction: string;
  currencySymbol: string;
}) {
  const today = todayDateString();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Due</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {occurrences.map((occurrence) => (
          <TableRow key={occurrence.id}>
            <TableCell className="text-xs">{formatDate(occurrence.dueDate)}</TableCell>
            <TableCell>
              {/* Still `scheduled` but past due is what the rest of the
                  app calls overdue — the dashboard counts these rows
                  under exactly that word, so the badge cannot keep
                  reading "Scheduled" here. Presentation only; the stored
                  status is untouched. */}
              {occurrence.status === 'scheduled' && occurrence.dueDate < today ? (
                <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                  Overdue
                </Badge>
              ) : (
                <Badge
                  variant={OCCURRENCE_STATUS_VARIANT[occurrence.status] ?? 'outline'}
                  className="text-[10px] px-1.5 py-0"
                >
                  {formatOccurrenceStatus(occurrence.status, direction)}
                </Badge>
              )}
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">
              {(occurrence.actualAmount ?? occurrence.expectedAmount)
                ? formatCurrency(
                    occurrence.actualAmount ?? occurrence.expectedAmount,
                    currencySymbol
                  )
                : '—'}
            </TableCell>
            <TableCell className="text-right">
              {occurrence.status === 'scheduled' ? (
                <OccurrenceActions
                  occurrenceId={occurrence.id}
                  expectedAmount={occurrence.expectedAmount}
                  direction={direction === 'inflow' ? 'inflow' : 'outflow'}
                />
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function PaymentDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const utils = trpc.useUtils();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [showAllUpcoming, setShowAllUpcoming] = useState(false);

  const paymentQuery = trpc.payments.get.useQuery({ paymentId: id }, { enabled: Boolean(id) });
  const { data: vendors, isLoading: vendorsLoading } = trpc.vendors.list.useQuery();
  const { data: tokens, isLoading: tokensLoading } = trpc.tokens.getAll.useQuery();
  const { data: accounts, isLoading: accountsLoading } =
    trpc.accounts.getByUserIdWithSummary.useQuery();

  const pauseMutation = trpc.payments.pause.useMutation({
    onSuccess: () => {
      showSuccess('Payment paused');
      void utils.payments.invalidate();
    },
    onError: (error) => showError(error, 'Pausing payment'),
  });

  const endMutation = trpc.payments.end.useMutation({
    onSuccess: () => {
      setConfirmEnd(false);
      showSuccess('Payment ended');
      void utils.payments.invalidate();
    },
    onError: (error) => showError(error, 'Ending payment'),
  });

  if (!id) return null;
  if (paymentQuery.isLoading || vendorsLoading || tokensLoading || accountsLoading) {
    return <PageLoader />;
  }
  if (paymentQuery.error || !paymentQuery.data) {
    return (
      <div className="space-y-6">
        <BackLink />
        <p className="text-sm text-destructive">Payment not found.</p>
      </div>
    );
  }

  const { payment, occurrences } = paymentQuery.data;
  const vendorName =
    (vendors ?? []).find((v) => v.id === payment.vendorId)?.displayName ?? 'Unknown vendor';
  const currencySymbol =
    (tokens ?? []).find((t) => t.id === payment.currencyTokenId)?.symbol ?? 'USD';
  const accountName = payment.accountId
    ? (accounts ?? []).find((a) => a.id === payment.accountId)?.name
    : null;

  const intervalUnit = asPaymentIntervalUnit(payment.intervalUnit);
  const monthly = payment.expectedAmount
    ? monthlyEquivalent(payment.expectedAmount, intervalUnit, payment.intervalCount)
    : null;

  // The router returns occurrences dueDate-ascending, so `upcoming` is
  // already next-due-first; `past` reverses to most-recent-first. Both
  // lead with the row closest to today, which is the one worth reading.
  // An overdue occurrence is still `scheduled`, so it keeps its settle
  // actions here in the past section.
  const today = todayDateString();
  const upcoming = occurrences.filter((o) => o.dueDate >= today);
  const past = occurrences.filter((o) => o.dueDate < today).reverse();
  const matchedOccurrences = occurrences.filter((o) => o.matchedTransactionId);
  const documentedOccurrences = occurrences.filter((o) => o.matchedExtractionId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <BackLink />
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" asChild>
            <Link to={V2_ROUTES.paymentEdit(payment.id)}>
              <Pencil className="h-4 w-4 mr-1" />
              Edit
            </Link>
          </Button>
          {payment.status === 'active' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pauseMutation.isPending}
              onClick={() => pauseMutation.mutate({ paymentId: payment.id })}
            >
              <Pause className="h-4 w-4 mr-1" />
              Pause
            </Button>
          )}
          {payment.status !== 'ended' && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmEnd(true)}
            >
              <StopCircle className="h-4 w-4 mr-1" />
              End
            </Button>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-2xl font-bold tracking-tight">{vendorName}</h2>
          <Badge
            variant={payment.status === 'active' ? 'default' : 'secondary'}
            className="capitalize"
          >
            {payment.status}
          </Badge>
          <Badge variant="outline">{payment.direction === 'inflow' ? 'Income' : 'Bill'}</Badge>
          <Badge variant="outline" className="capitalize">
            {payment.kind}
          </Badge>
        </div>
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold tabular-nums">
              {payment.expectedAmount
                ? formatCurrency(payment.expectedAmount, currencySymbol)
                : '—'}
            </span>
            <span className="text-sm text-muted-foreground">
              {formatPaymentInterval(intervalUnit, payment.intervalCount)}
            </span>
          </div>
          {monthly && (
            <p className="text-xs text-muted-foreground">
              ≈ {formatCurrency(monthly.toString(), currencySymbol)} / month
            </p>
          )}
          <Separator />
          <dl className="grid grid-cols-2 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Anchor date</dt>
            <dd className="text-right">{formatDate(payment.anchorDate)}</dd>
            {payment.endDate && (
              <>
                <dt className="text-muted-foreground">End date</dt>
                <dd className="text-right">{formatDate(payment.endDate)}</dd>
              </>
            )}
            {accountName && (
              <>
                <dt className="text-muted-foreground">Account</dt>
                <dd className="text-right">{accountName}</dd>
              </>
            )}
            {payment.notes && (
              <>
                <dt className="text-muted-foreground">Notes</dt>
                <dd className="text-right">{payment.notes}</dd>
              </>
            )}
          </dl>
        </CardContent>
      </Card>

      {occurrences.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Occurrences</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">No occurrences yet.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Each section renders only when it has rows — a payment
              created today has no past, and an ended one has no
              upcoming; an empty card in either case is just noise. */}
          {upcoming.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Upcoming ({upcoming.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <OccurrenceTable
                  occurrences={showAllUpcoming ? upcoming : upcoming.slice(0, UPCOMING_PREVIEW)}
                  direction={payment.direction}
                  currencySymbol={currencySymbol}
                />
                {/* A fortnightly payment materialises 26 rows ahead. All
                    of them expanded push the Past section a full screen
                    down, which defeats the point of splitting the two. */}
                {upcoming.length > UPCOMING_PREVIEW && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 w-full"
                    onClick={() => setShowAllUpcoming((shown) => !shown)}
                  >
                    {showAllUpcoming ? 'Show fewer' : `Show all ${upcoming.length}`}
                  </Button>
                )}
              </CardContent>
            </Card>
          )}
          {past.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Past ({past.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <OccurrenceTable
                  occurrences={past}
                  direction={payment.direction}
                  currencySymbol={currencySymbol}
                />
              </CardContent>
            </Card>
          )}
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Receipt className="h-3.5 w-3.5" />
            Matched transactions ({matchedOccurrences.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {matchedOccurrences.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No occurrence has been matched to a bank transaction yet.
            </p>
          ) : (
            <div className="divide-y">
              {matchedOccurrences.map((occurrence) => (
                <div key={occurrence.id} className="flex items-center justify-between py-2 text-xs">
                  <span>{formatDate(occurrence.dueDate)}</span>
                  <span className="tabular-nums">
                    {occurrence.actualAmount
                      ? formatCurrency(occurrence.actualAmount, currencySymbol)
                      : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            Attached documents ({documentedOccurrences.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {documentedOccurrences.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No occurrence has an uploaded invoice attached yet.
            </p>
          ) : (
            <div className="divide-y">
              {documentedOccurrences.map((occurrence) => (
                <div key={occurrence.id} className="flex items-center justify-between py-2 text-xs">
                  <span>{formatDate(occurrence.dueDate)}</span>
                  <span className="text-muted-foreground">Invoice on file</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmEnd}
        onOpenChange={setConfirmEnd}
        title="End this payment"
        description={`This ends "${vendorName}" as of today and removes every future scheduled occurrence. It cannot be undone.`}
        confirmLabel="End payment"
        variant="destructive"
        isPending={endMutation.isPending}
        onConfirm={() => endMutation.mutate({ paymentId: payment.id })}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Button variant="ghost" size="sm" asChild className="h-7 gap-1 -ml-2">
      <Link to={V2_ROUTES.paymentsList}>
        <ArrowLeft className="h-3.5 w-3.5" />
        All payments
      </Link>
    </Button>
  );
}
