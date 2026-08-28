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
import type { TFunction } from 'i18next';
import { ArrowUpRight, CalendarClock } from 'lucide-react';
import { useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import type { RouterOutputs } from '@/lib/trpc';
import {
  directionLabel,
  estimatedTotals,
  formatOverdueBy,
  groupUpcoming,
  historyEstimateFor,
  INCOME_HORIZON_DAYS,
  isIncome,
  occurrenceTotals,
  PAYMENTS_HORIZON_DAYS,
  splitByDirection,
  splitByDueness,
  withinDays,
} from '../../lib/money';
import {
  formatPaymentInterval,
  type HistoryEstimate,
  todayDateString,
} from '../../lib/paymentTotals';
import { V3_PAYMENT_ROUTES, V3_ROUTES } from '../../lib/routes';
import { BaseEquivalent } from '../BaseEquivalent';
import { ConvertedFigure } from '../ConvertedFigure';
import { ConvertedTotal } from '../ConvertedTotal';
import { EstimatedFromHistory } from './EstimatedFromHistory';
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
  /**
   * Which payments the projection priced from their own settled history
   * (SC-625), keyed by payment id — the same map the recurring list, the vendor
   * list and the projection read, derived once in `MoneyPage`.
   *
   * Threaded in rather than derived here for the reason `historyEstimatesByPaymentId`
   * exists at all: four surfaces state what one payment costs, and they agree
   * because they read one answer, not because four implementations are kept in
   * step.
   */
  historyEstimates: ReadonlyMap<string, HistoryEstimate>;
}

function vendorFor(
  t: TFunction,
  occurrence: UpcomingOccurrence,
  names: Map<string, string>
): string {
  return names.get(occurrence.payment.vendorId) ?? t('v3.common.unknownVendor');
}

/**
 * What one occurrence looks like in the sheet.
 *
 * Pulled out of the component and exported for the reason `holdingPeekSpec` is:
 * the sheet mounts through a Radix portal, so `renderToStaticMarkup` renders
 * NONE of it, and a claim about the peek can only be checked against the spec
 * as data. That is not a preference — SC-797 is a defect that shipped precisely
 * because a second render site was invisible to a green suite, and the SC-625
 * mark is exactly the kind of thing that goes to one site and not the other.
 */
export interface UpcomingPeekContext {
  t: TFunction;
  occurrence: UpcomingOccurrence;
  vendorNameById: Map<string, string>;
  tokenSymbolById: Map<string, string>;
  historyEstimates: ReadonlyMap<string, HistoryEstimate>;
  /** `YYYY-MM-DD`, taken from the feed so the sheet and the rows behind it
   *  cannot disagree about which day it is. */
  today: string;
  onSettled: () => void;
}

export function upcomingPeekSpec({
  t,
  occurrence,
  vendorNameById,
  tokenSymbolById,
  historyEstimates,
  today,
  onSettled,
}: UpcomingPeekContext): PeekSpec {
  // Same substitution as the row, through the same function: a peek opened from
  // a row showing a figure must not say "No value".
  const estimate = historyEstimateFor(occurrence, historyEstimates);

  return {
    title: vendorFor(t, occurrence, vendorNameById),
    // An income row is peeked from the block below, so the sheet has to
    // hold the same distinction the two blocks do: a bill is due, income is
    // expected, and a payer who is late is not the reader being overdue.
    subtitle: isIncome(occurrence)
      ? // Three whole sentences rather than one with a clause appended:
        // "· not received yet" is a fragment glued to the end in English
        // and would have to move in a language that fronts it.
        occurrence.dueDate < today
        ? t('v3.money.peek.expectedOnLate', { date: formatDate(occurrence.dueDate) })
        : t('v3.money.peek.expectedOn', { date: formatDate(occurrence.dueDate) })
      : occurrence.dueDate < today
        ? formatOverdueBy(occurrence.dueDate, today, t)
        : t('v3.money.peek.dueOn', { date: formatDate(occurrence.dueDate) }),
    value: (
      <Numeric
        value={occurrence.expectedAmount ?? occurrence.actualAmount ?? estimate?.amount ?? null}
        currency={tokenSymbolById.get(occurrence.payment.currencyTokenId) ?? 'USD'}
      />
    ),
    // `delta` shares the figure's own line and wraps under it, which is the
    // same slot the row uses — so the mark sits beside the number in both
    // places. A caveat that scrolls away from the figure it qualifies is not a
    // caveat.
    delta: estimate ? <EstimatedFromHistory sourceDueDate={estimate.sourceDueDate} /> : undefined,
    actions: (
      <>
        <SettleActions
          occurrenceId={occurrence.id}
          expectedAmount={occurrence.expectedAmount}
          direction={occurrence.payment.direction === 'inflow' ? 'inflow' : 'outflow'}
          onSettled={onSettled}
        />
        {/* `outline`, matching Skip beside it — as a `ghost` this was bare
            text next to two drawn buttons, which made the only way to
            change the payment itself the least button-like thing in the
            row (SC-69 2.4). It is a real action and it leaves the sheet
            for a form; the primary stays with settling, which is what the
            sheet is for. */}
        <Button variant="outline" asChild>
          <Link to={V3_PAYMENT_ROUTES.edit(occurrence.payment.id)}>
            {t('v3.money.peek.editPayment')}
          </Link>
        </Button>
      </>
    ),
    primary: [
      { label: t('v3.money.peek.due'), value: formatDate(occurrence.dueDate) },
      {
        label: t('v3.money.field.direction'),
        value: directionLabel(occurrence.payment.direction, t),
      },
      {
        label: t('v3.money.peek.repeats'),
        value: formatPaymentInterval(
          t,
          occurrence.payment.intervalUnit,
          occurrence.payment.intervalCount
        ),
      },
      {
        // "Amount is", not "Amount" — the figure above the facts is the
        // amount, and a second row headed the same thing reads as a
        // contradiction rather than as the fixed/variable distinction.
        label: t('v3.money.peek.amountIs'),
        value:
          occurrence.payment.kind === 'variable'
            ? t('v3.money.peek.varies')
            : t('v3.money.peek.fixed'),
      },
    ],
    sections: occurrence.payment.notes
      ? [
          {
            title: t('v3.money.peek.notes'),
            facts: [{ label: t('v3.money.peek.note'), value: occurrence.payment.notes }],
          },
        ]
      : undefined,
  };
}

export function UpcomingFeed({
  occurrences,
  paymentCount,
  vendorNameById,
  tokenSymbolById,
  rates,
  query,
  historyEstimates,
}: UpcomingFeedProps) {
  const { t } = useTranslation();
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

  const groups = useMemo(() => groupUpcoming(t, bills, today), [bills, today, t]);

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

  // The other half of `committed`, over exactly the same set (SC-807). An
  // occurrence priced from its own history contributes `'0'` to the figure
  // above and `€84.20` to the row below it, and until this line the money
  // appeared nowhere between them — a headline reading `€0.00` directly over a
  // row reading `€84.20 · ESTIMATED · from Feb 2026`.
  const estimated = useMemo(
    () => estimatedTotals(ahead, historyEstimates),
    [ahead, historyEstimates]
  );

  // The same defect on the tile 40px below, and it is in this PR for a reason
  // about the SCREEN rather than about the file. Shipping one honest figure
  // beside a dishonest one is worse than shipping neither: the honest one
  // implies the surface was checked, so a reader who sees the committed figure
  // name its exclusion will read the tile beside it as having none to name.
  // The three remaining `occurrenceTotals` surfaces are separate screens seen
  // at separate moments, and stay on SC-818 with their own wording decisions.
  const estimatedOverdue = useMemo(
    () => estimatedTotals(overdue, historyEstimates),
    [overdue, historyEstimates]
  );

  const peeked = occurrences.find((occurrence) => occurrence.id === peekRoute.id) ?? null;

  const spec: PeekSpec | null = peeked
    ? upcomingPeekSpec({
        t,
        occurrence: peeked,
        vendorNameById,
        tokenSymbolById,
        historyEstimates,
        today,
        onSettled: peekRoute.close,
      })
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
    return (
      <QueryError
        error={query.error}
        subject={t('v3.money.upcoming.label')}
        onRetry={query.retry}
      />
    );
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
          label={t('v3.money.upcoming.label')}
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
            titleKey:
              paymentCount > 0
                ? 'ui.dataView.upcoming.empty.nothingDue'
                : 'ui.dataView.upcoming.empty.noPayments',
            values: { count: INCOME_HORIZON_DAYS },
            descriptionKey:
              paymentCount > 0
                ? 'ui.dataView.upcoming.empty.outsideWindow'
                : 'ui.dataView.upcoming.empty.addOne',
            action:
              paymentCount > 0 ? (
                <Button variant="outline" asChild>
                  <Link to={V3_ROUTES.recurring}>{t('v3.money.upcoming.seeRecurring')}</Link>
                </Button>
              ) : (
                <Button asChild>
                  <Link to={V3_PAYMENT_ROUTES.create}>{t('v3.money.upcoming.addPayment')}</Link>
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
          label={t('v3.money.upcoming.billsCommitted', { count: PAYMENTS_HORIZON_DAYS })}
          totals={committed}
          tokenSymbolById={tokenSymbolById}
          rates={rates}
        />

        {/* What the figure above LEAVES OUT, named with its amount — the same
            move `<ConvertedTotal>`'s own "Not included:" captions make for a
            currency it could not convert, and the same move
            `<RecurringSummary>` makes with `unestimatedCount`. A total with
            nothing beside it reads as complete whether or not it is.

            The figure is deliberately NOT widened to absorb this. "Bills
            committed" and "what is due next" are different claims: an estimate
            is the reader telling us we do not know this month's amount, and a
            headline can carry no `<EstimatedFromHistory>` mark to say which
            part of it is guessed. What was wrong was never the `0.00` — it was
            that the €84.20 was accounted for nowhere above the rows.

            Conditional, and the asymmetry is the point: with nothing estimated
            there is nothing excluded, and a permanent line reading €0.00 would
            assert a category most books never have. The cost, stated: a reader
            who never estimates never learns the committed figure has an
            exclusion rule — but for them it excludes nothing, so there is no
            figure to qualify.

            A `<span className="block">` rather than the `<p>` its siblings use:
            `<ConvertedFigure>` renders a `<div>` skeleton while the rates are
            in flight, and the HTML parser closes a `<p>` at a `<div>` — which
            is a hydration mismatch rather than a style problem. */}
        {estimated.count > 0 ? (
          <span className="block text-caption text-muted-foreground">
            {/* One key for the whole sentence with the figure as a slot
                (SC-201/SC-235): "Excludes X from N bills…" puts its verb, its
                amount and its reason in an order several of these languages do
                not share, and splitting it would pin English word order into
                this JSX. */}
            <Trans
              i18nKey="v3.money.upcoming.estimatedExcluded"
              count={estimated.count}
              components={{
                amounts: (
                  <ConvertedFigure
                    totals={estimated.totals}
                    tokenSymbolById={tokenSymbolById}
                    rates={rates}
                  />
                ),
              }}
            />
          </span>
        ) : null}

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
              label={t('v3.money.upcoming.overdueTotal', { count: overdue.length })}
              totals={pastDue}
              tokenSymbolById={tokenSymbolById}
              rates={rates}
            />

            {/* Its OWN sentence, not the committed figure's (SC-201's rule,
                and the same reason `<ConvertedTotal>` keeps `notIncluded` and
                `ratesUnavailable` apart). The clause that makes the headline
                above legible is "an estimate is not a commitment", and this
                tile does not claim commitment — it claims what is already late.
                Reusing that key here would put a true sentence under the wrong
                figure, and a reader with both lines on screen would see two
                captions differing only in the amount, which reads as a
                rendering fault rather than as two facts. */}
            {estimatedOverdue.count > 0 ? (
              <span className="block text-caption text-muted-foreground">
                <Trans
                  i18nKey="v3.money.upcoming.estimatedExcludedOverdue"
                  count={estimatedOverdue.count}
                  components={{
                    amounts: (
                      <ConvertedFigure
                        totals={estimatedOverdue.totals}
                        tokenSymbolById={tokenSymbolById}
                        rates={rates}
                      />
                    ),
                  }}
                />
              </span>
            ) : null}
          </div>
        ) : null}
      </Block>

      {ahead.length === 0 ? (
        <p className="px-4 text-body text-muted-foreground">
          {t('v3.money.upcoming.noneAhead', { count: PAYMENTS_HORIZON_DAYS })}
        </p>
      ) : null}

      {groups.map((group) => (
        <section key={group.key} className="flex flex-col gap-1">
          <div className="px-4">
            <DataViewGroupHeading label={group.label} count={group.items.length} />
          </div>
          <DataRowList>
            {group.items.map((occurrence) => {
              const vendorName = vendorFor(t, occurrence, vendorNameById);
              const estimate = historyEstimateFor(occurrence, historyEstimates);
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
                  sublabel={
                    group.overdue ? formatOverdueBy(occurrence.dueDate, today, t) : undefined
                  }
                  value={
                    <Numeric
                      value={
                        occurrence.expectedAmount ?? occurrence.actualAmount ?? estimate?.amount
                      }
                      currency={tokenSymbolById.get(occurrence.payment.currencyTokenId) ?? 'USD'}
                    />
                  }
                  // The mark takes the second line, replacing the
                  // base-currency equivalent — the same trade `<RecurringList>`
                  // makes, and for the same reason: converting a figure into
                  // another currency says less about it than saying it is last
                  // February's. An unconverted estimate is a small loss; an
                  // estimate indistinguishable from a fixed bill is the one
                  // thing SC-625 exists to prevent.
                  delta={
                    estimate ? (
                      <EstimatedFromHistory sourceDueDate={estimate.sourceDueDate} />
                    ) : (
                      <BaseEquivalent
                        amount={occurrence.expectedAmount ?? occurrence.actualAmount}
                        currencyTokenId={occurrence.payment.currencyTokenId}
                        rates={rates}
                      />
                    )
                  }
                  onClick={() => peekRoute.open(occurrence.id)}
                  aria-label={t('v3.money.upcoming.row', {
                    vendor: vendorName,
                    date: formatDate(occurrence.dueDate),
                  })}
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
