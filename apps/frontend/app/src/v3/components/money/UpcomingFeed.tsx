import { formatDate } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Block } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { DataViewEmpty } from '@scani/ui/v3/components/data-view/DataViewEmpty';
import { DataViewSkeleton } from '@scani/ui/v3/components/data-view/DataViewSkeleton';
import { DataViewGroupHeading } from '@scani/ui/v3/components/data-view/V3DataView';
import { LoadingRamp } from '@scani/ui/v3/components/feedback/LoadingRamp';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { PeekSheet } from '@scani/ui/v3/components/PeekSheet';
import { useDelayedLoading } from '@scani/ui/v3/hooks/useDelayedLoading';
import { usePeekRoute } from '@scani/ui/v3/hooks/usePeekRoute';
import type { PeekSpec } from '@scani/ui/v3/lib/peek';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { ArrowUpRight, CalendarClock } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import type { RouterOutputs } from '@/lib/trpc';
import {
  asPaymentIntervalUnit,
  formatPaymentInterval,
  todayDateString,
} from '@/v2/lib/paymentTotals';
import {
  directionLabel,
  formatOverdueBy,
  groupUpcoming,
  INCOME_HORIZON_DAYS,
  isIncome,
  occurrenceTotals,
  overdueTotalLabel,
  PAYMENTS_HORIZON_DAYS,
  splitByDirection,
  splitByDueness,
  withinDays,
} from '../../lib/money';
import { V3_PAYMENT_ROUTES, V3_ROUTES } from '../../lib/routes';
import { BaseEquivalent } from '../BaseEquivalent';
import { ConvertedTotal } from '../ConvertedTotal';
import { ExpectedIncome } from './ExpectedIncome';
import { SettleActions } from './SettleActions';

/**
 * The Money tab's default view: what the reader owes in the next thirty days,
 * in the order it falls due, with everything already late gathered at the top —
 * and, beneath it and separately, what they expect to receive.
 *
 * V3-47 split the two. The committed figure had always been filtered to
 * outflow; the feed under it had not, so an income invoice appeared as a row
 * under a heading that described bills, and the total the reader checked it
 * against did not contain it. The heading now describes its own list, and
 * income is a block of its own with its own horizon (`<ExpectedIncome>`) —
 * never a row in this feed, and never netted against it.
 *
 * Not a `<V3DataView>`, and the reason is the grouping. This feed's groups are
 * *dates*, decided by the data rather than chosen by the reader, and
 * `useDataView`'s `groupBy` is user state with no config seed — a surface
 * cannot ask it for a default. Search, filter and sort are also the wrong
 * controls for a thirty-day window of typically under a dozen rows: the
 * refinement they offer is "scroll". So the feed composes the same primitives
 * the list surface does (`<DataRowList>`, `<DataRow>`, `DataViewGroupHeading`,
 * `<PeekSheet>`) without the toolbar that would sit above it doing nothing.
 *
 * The peek lives at `/v3/payments/:occurrenceId` — one segment under the feed's
 * own route, which is why `resolveMoneySegment` claims `recurring` before it
 * falls through to reading a segment as an id.
 */

type UpcomingOccurrence = RouterOutputs['payments']['upcoming'][number];

interface UpcomingFeedProps {
  /** Every scheduled occurrence inside the *income* horizon — the longer of the
   *  two windows. The 30-day bill set is taken from it here. */
  occurrences: UpcomingOccurrence[];
  /** Every recurring payment, for the "nothing due, but you do have payments"
   *  empty state — a near-empty feed otherwise reads as "my payments were never
   *  created", which is what happened to four real invoices on 2026-08-12. */
  paymentCount: number;
  vendorNameById: Map<string, string>;
  tokenSymbolById: Map<string, string>;
  /** Base-currency conversion for the committed figure and every row under it. */
  rates: BaseCurrencyRates;
  query: V3QueryState;
}

function vendorFor(occurrence: UpcomingOccurrence, names: Map<string, string>): string {
  return names.get(occurrence.payment.vendorId) ?? 'Unknown vendor';
}

export function UpcomingFeed({
  occurrences,
  paymentCount,
  vendorNameById,
  tokenSymbolById,
  rates,
  query,
}: UpcomingFeedProps) {
  const peekRoute = usePeekRoute(V3_ROUTES.money);
  const loadingPhase = useDelayedLoading(query.isLoading);
  const today = todayDateString();

  // The split happens once, before anything is summed or rendered, so no
  // figure on this screen can end up describing a different set than the list
  // under it. Bills are cut back to the thirty-day window; income keeps the
  // whole lookahead.
  const { bills, income } = useMemo(() => {
    const split = splitByDirection(occurrences);
    return {
      bills: withinDays(split.bills, today, PAYMENTS_HORIZON_DAYS),
      income: split.income,
    };
  }, [occurrences, today]);

  const groups = useMemo(() => groupUpcoming(bills, today), [bills, today]);

  // Second split, same reason as the first: a figure may only describe the set
  // it names. The feed lists overdue and upcoming under separate headings and
  // always has — the total above them was the one place they were added
  // together, and it carried the forward window's label (SC-77 1).
  const { overdue, ahead } = useMemo(() => splitByDueness(bills, today), [bills, today]);

  // A raw sum of the real instances in the window, never an annualised
  // projection — and never with income subtracted from it. `<ConvertedTotal>`
  // turns the per-currency map into the one base-currency figure the reader
  // asked for (V3-52); the income block below and the overdue figure beside it
  // reach their own figures through exactly the same helper, so none of them
  // can end up as a list while another is a number.
  const committed = useMemo(() => occurrenceTotals(ahead), [ahead]);
  const pastDue = useMemo(() => occurrenceTotals(overdue), [overdue]);

  const peeked = occurrences.find((occurrence) => occurrence.id === peekRoute.id) ?? null;

  const spec: PeekSpec | null = peeked
    ? {
        title: vendorFor(peeked, vendorNameById),
        // An income row is peeked from the block below, so the sheet has to
        // hold the same distinction the two blocks do: a bill is due, income is
        // expected, and a payer who is late is not the reader being overdue.
        subtitle: isIncome(peeked)
          ? `Expected ${formatDate(peeked.dueDate)}${peeked.dueDate < today ? ' · not received yet' : ''}`
          : peeked.dueDate < today
            ? formatOverdueBy(peeked.dueDate, today)
            : `Due ${formatDate(peeked.dueDate)}`,
        value: (
          <Numeric
            value={peeked.expectedAmount ?? peeked.actualAmount}
            currency={tokenSymbolById.get(peeked.payment.currencyTokenId) ?? 'USD'}
          />
        ),
        actions: (
          <>
            <SettleActions
              occurrenceId={peeked.id}
              expectedAmount={peeked.expectedAmount}
              direction={peeked.payment.direction === 'inflow' ? 'inflow' : 'outflow'}
              onSettled={peekRoute.close}
            />
            {/* `outline`, matching Skip beside it — as a `ghost` this was bare
                text next to two drawn buttons, which made the only way to
                change the payment itself the least button-like thing in the
                row (SC-69 2.4). It is a real action and it leaves the sheet
                for a form; the primary stays with settling, which is what the
                sheet is for. */}
            <Button variant="outline" asChild>
              <Link to={V3_PAYMENT_ROUTES.edit(peeked.payment.id)}>Edit payment</Link>
            </Button>
          </>
        ),
        primary: [
          { label: 'Due', value: formatDate(peeked.dueDate) },
          { label: 'Direction', value: directionLabel(peeked.payment.direction) },
          {
            label: 'Repeats',
            value: formatPaymentInterval(
              asPaymentIntervalUnit(peeked.payment.intervalUnit),
              peeked.payment.intervalCount
            ),
          },
          {
            // "Amount is", not "Amount" — the figure above the facts is the
            // amount, and a second row headed the same thing reads as a
            // contradiction rather than as the fixed/variable distinction.
            label: 'Amount is',
            value: peeked.payment.kind === 'variable' ? 'Varies' : 'Fixed',
          },
        ],
        sections: peeked.payment.notes
          ? [{ title: 'Notes', facts: [{ label: 'Note', value: peeked.payment.notes }] }]
          : undefined,
      }
    : null;

  const sheet = (
    <PeekSheet
      open={peekRoute.id !== null}
      onOpenChange={(next) => {
        if (!next) peekRoute.close();
      }}
      spec={spec}
      noun="payment"
      isLoading={query.isLoading}
    />
  );

  // The error takes the surface only when there is nothing else to put there
  // — a failed background refetch behind a feed already on screen leaves the
  // feed standing rather than replacing it with a panel.
  if (query.isError && occurrences.length === 0) {
    return <QueryError error={query.error} subject="upcoming payments" onRetry={query.retry} />;
  }

  if (query.isLoading) {
    return (
      <>
        {/* §2.5's ramp: nothing for 300ms, because this feed is one of the two
            queries the home screen has already warmed and a skeleton over a
            cached answer is the flash V3-16 exists to delete. */}
        <LoadingRamp
          phase={loadingPhase}
          skeleton={<DataViewSkeleton />}
          label="upcoming payments"
          onRetry={query.retry}
        />
        {sheet}
      </>
    );
  }

  // Nothing anywhere in the lookahead — the one case where the surface has no
  // figure worth printing. Deliberately not "no bills in the next thirty days":
  // a bill due on day 45 is outside the bill window but inside this query, and
  // an empty screen claiming nothing is due for ninety days would be false.
  if (occurrences.length === 0) {
    return (
      <>
        <DataViewEmpty
          empty={{
            icon: CalendarClock,
            title:
              paymentCount > 0
                ? `Nothing due in the next ${INCOME_HORIZON_DAYS} days`
                : 'No recurring payments yet',
            description:
              paymentCount > 0
                ? 'Your standing payments fall due outside this window.'
                : 'Add a bill or recurring income and its next dates show up here.',
            action:
              paymentCount > 0 ? (
                <Button variant="outline" asChild>
                  <Link to={V3_ROUTES.recurring}>See recurring payments</Link>
                </Button>
              ) : (
                <Button asChild>
                  <Link to={V3_PAYMENT_ROUTES.create}>Add a payment</Link>
                </Button>
              ),
          }}
        />
        {sheet}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Block className="flex flex-col gap-2 p-4">
        <ConvertedTotal
          // "Committed", against income's "expected": the two figures on this
          // screen differ in how certain they are, and that is the distinction
          // the words have to carry. The window is named on both, because they
          // are not the same window and nothing should invite adding them.
          label={`Bills committed, next ${PAYMENTS_HORIZON_DAYS} days`}
          totals={committed}
          tokenSymbolById={tokenSymbolById}
          rates={rates}
        />

        {/* Overdue money does not vanish into the figure above it and does not
            get a screen of its own: it is the same obligation, one deadline
            further back, so it sits in the same block as a `default` tile
            under the view's one hero (§2.1). The reader can add the two
            themselves if they want "everything outstanding" — what they can no
            longer do is read either number as the other. */}
        {overdue.length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <ConvertedTotal
              emphasis="default"
              label={overdueTotalLabel(overdue.length)}
              totals={pastDue}
              tokenSymbolById={tokenSymbolById}
              rates={rates}
            />
          </div>
        ) : null}
      </Block>

      {ahead.length === 0 ? (
        <p className="px-4 text-body text-muted-foreground">
          Nothing due in the next {PAYMENTS_HORIZON_DAYS} days.
        </p>
      ) : null}

      {groups.map((group) => (
        <section key={group.key} className="flex flex-col gap-1">
          <div className="px-4">
            <DataViewGroupHeading label={group.label} count={group.items.length} />
          </div>
          <DataRowList>
            {group.items.map((occurrence) => {
              const vendorName = vendorFor(occurrence, vendorNameById);
              return (
                <DataRow
                  key={occurrence.id}
                  leading={
                    <ArrowUpRight aria-hidden="true" className="size-4 text-muted-foreground" />
                  }
                  label={vendorName}
                  // The overdue group spans many dates, so its rows carry one;
                  // a date group's heading already said it. Nothing says "Bill"
                  // any more either — every row in this feed is one, and the
                  // figure above says so.
                  sublabel={group.overdue ? formatOverdueBy(occurrence.dueDate, today) : undefined}
                  value={
                    <Numeric
                      value={occurrence.expectedAmount ?? occurrence.actualAmount}
                      currency={tokenSymbolById.get(occurrence.payment.currencyTokenId) ?? 'USD'}
                    />
                  }
                  delta={
                    <BaseEquivalent
                      amount={occurrence.expectedAmount ?? occurrence.actualAmount}
                      currencyTokenId={occurrence.payment.currencyTokenId}
                      rates={rates}
                    />
                  }
                  onClick={() => peekRoute.open(occurrence.id)}
                  aria-label={`${vendorName}, due ${formatDate(occurrence.dueDate)}`}
                />
              );
            })}
          </DataRowList>
        </section>
      ))}

      {/* Below the bills, not among them, and never inside their total. */}
      <ExpectedIncome
        occurrences={income}
        vendorNameById={vendorNameById}
        tokenSymbolById={tokenSymbolById}
        rates={rates}
        today={today}
        onPeek={peekRoute.open}
      />

      {sheet}
    </div>
  );
}
