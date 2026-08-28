import { formatDate } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { V3DataViewConfig, V3FilterOption } from '@scani/ui/v3/lib/data-view';
import { exportText } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { Repeat } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import type { RouterOutputs } from '@/lib/trpc';
import { exportMoneyInBase } from '../../lib/export-money';
import { directionLabel } from '../../lib/money';
import {
  asPaymentIntervalUnit,
  formatPaymentInterval,
  type HistoryEstimate,
  monthlyEquivalent,
} from '../../lib/paymentTotals';
import { V3_PAYMENT_ROUTES, V3_ROUTES } from '../../lib/routes';
import { BaseEquivalent } from '../BaseEquivalent';
import { DeletePaymentAction } from './DeletePaymentAction';
import { EndPaymentAction } from './EndPaymentAction';
import { EstimatedFromHistory } from './EstimatedFromHistory';
import { PaymentStatusToggle } from './PaymentStatusToggle';
import { RecurringSummary } from './RecurringSummary';

/**
 * Every standing commitment on record — the "Recurring" view of the Money tab.
 *
 * This one *is* a `<V3DataView>`: the list is unbounded, the reader arrives
 * with a question ("which of my bills is the €40 one", "what is paused"), and
 * search, direction, status and sort are the controls that answer it. The feed
 * next door has none of those properties, which is why it is not one.
 *
 * A payment's record opens as a peek rather than a page. Everything v2's
 * 412-line `PaymentDetailPage` shows above its occurrence tables is eight
 * facts, and eight facts is a sheet.
 */

type PaymentRow = RouterOutputs['payments']['list'][number];

/**
 * Active is the default state, so it gets quiet text and only the exceptions
 * get a badge. v2 badged all three, and `active` drew the primary colour —
 * five brand-coloured pills down a table, on the least informative column,
 * pulling the eye away from the vendor and the figure.
 */
function StatusCell({ status }: { status: string }) {
  if (status === 'active') {
    return <span className="capitalize text-muted-foreground">{status}</span>;
  }
  return (
    <Badge variant="secondary" className="capitalize">
      {status}
    </Badge>
  );
}

const STATUS_OPTIONS: V3FilterOption[] = [
  { labelKey: 'ui.dataView.payments.option.active', value: 'active' },
  { labelKey: 'ui.dataView.payments.option.paused', value: 'paused' },
  { labelKey: 'ui.dataView.payments.option.ended', value: 'ended' },
];

const DIRECTION_OPTIONS: V3FilterOption[] = [
  { labelKey: 'ui.dataView.payments.option.bill', value: 'outflow' },
  { labelKey: 'ui.dataView.payments.option.income', value: 'inflow' },
];

interface RecurringListProps {
  payments: PaymentRow[];
  vendorNameById: Map<string, string>;
  tokenSymbolById: Map<string, string>;
  /** Base-currency conversion for the summary and every row's second line. */
  rates: BaseCurrencyRates;
  query: V3QueryState;
  /**
   * From `payments.forecast` (SC-625): which payments the projection priced
   * from their own settled history, and from when.
   *
   * Read rather than recomputed. `payments.list` carries no occurrence data,
   * so this list could not derive an estimate even if it wanted to — and
   * taking the projection's answer is what stops the monthly figure here and
   * the one on the forecast from being two implementations of one rule.
   */
  historyEstimates: ReadonlyMap<string, HistoryEstimate>;
}

export function RecurringList({
  payments,
  vendorNameById,
  tokenSymbolById,
  rates,
  query,
  historyEstimates,
}: RecurringListProps) {
  const { t } = useTranslation();
  const vendorName = (payment: PaymentRow) =>
    vendorNameById.get(payment.vendorId) ?? t('v3.common.unknownVendor');
  const symbolFor = (payment: PaymentRow) => tokenSymbolById.get(payment.currencyTokenId) ?? 'USD';
  const amountForSort = (payment: PaymentRow) =>
    payment.expectedAmount ?? historyEstimates.get(payment.id)?.amount ?? '0';

  // Only vendors that actually own a payment, so the Refine sheet never offers
  // a narrowing that empties the list. Sorted by name — the order the reader
  // would look for one in.
  const vendorOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const payment of payments) {
      if (!seen.has(payment.vendorId)) {
        seen.set(
          payment.vendorId,
          vendorNameById.get(payment.vendorId) ?? t('v3.common.unknownVendor')
        );
      }
    }
    return [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    // `t` is a dependency: the fallback for a vendor with no name is a
    // translated string now, so without it the filter options keep the
    // language this memo was first built in (the fourth time extraction has
    // put `t` into a hook that never had one — SC-202).
  }, [payments, vendorNameById, t]);

  const config: V3DataViewConfig<PaymentRow> = {
    pageKey: 'payments',
    nounKey: 'ui.dataView.noun.payments',
    searchPlaceholderKey: 'ui.dataView.payments.config.searchByVendor',
    data: payments,
    searchFn: (payment, query) => vendorName(payment).toLowerCase().includes(query),
    filterDefs: [
      // Declared for the URL as much as for the Refine sheet: `pageKey` has no
      // `:` in it, so this filter's key is the parameter name, and
      // `/payments/recurring?vendor=<id>` — the link a vendor's peek emits —
      // is seeded straight into it by `V3DataView` (SC-83).
      {
        key: 'vendor',
        labelKey: 'ui.dataView.payments.filter.vendor',
        options: vendorOptions,
        fn: (payment: PaymentRow, value: string) => payment.vendorId === value,
      },
      {
        key: 'direction',
        labelKey: 'ui.dataView.payments.filter.direction',
        options: DIRECTION_OPTIONS,
        fn: (payment: PaymentRow, value: string) => payment.direction === value,
      },
      {
        key: 'status',
        labelKey: 'ui.dataView.payments.filter.status',
        options: STATUS_OPTIONS,
        fn: (payment: PaymentRow, value: string) => payment.status === value,
      },
    ],
    sortDefs: [
      { key: 'vendor', labelKey: 'ui.dataView.payments.sort.vendor' },
      { key: 'amount', labelKey: 'ui.dataView.payments.sort.amount' },
      { key: 'status', labelKey: 'ui.dataView.payments.sort.status' },
    ],
    sortFn: (a, b, field, direction) => {
      const mult = direction === 'asc' ? 1 : -1;
      switch (field) {
        case 'vendor':
          return vendorName(a).localeCompare(vendorName(b)) * mult;
        // SORT WHAT THE COLUMN SHOWS, NOT WHAT THE ROW DECLARES. An estimated
        // payment renders a figure in the `amount` cell, so keying the sort on
        // `expectedAmount` alone would sort it as zero and file it at one end
        // of a list it visibly does not belong at — the reader sorts by the
        // column they are looking at, and there is no way to see why the row
        // moved. `?? '0'` still catches what remains genuinely unestimated,
        // which is the case the count line beneath the total is about.
        case 'amount':
          return (Number.parseFloat(amountForSort(a)) - Number.parseFloat(amountForSort(b))) * mult;
        case 'status':
          return a.status.localeCompare(b.status) * mult;
        default:
          return 0;
      }
    },
    groupByDefs: [
      {
        key: 'status',
        labelKey: 'ui.dataView.payments.group.status',
        fn: (payment: PaymentRow) => payment.status,
      },
      {
        key: 'direction',
        labelKey: 'ui.dataView.payments.group.direction',
        fn: (payment: PaymentRow) => directionLabel(payment.direction, t),
      },
    ],
    defaultSort: { field: 'vendor', direction: 'asc' },
    summary: (items) => (
      <RecurringSummary
        payments={items}
        tokenSymbolById={tokenSymbolById}
        rates={rates}
        historyEstimates={historyEstimates}
      />
    ),
    renderRow: (payment) => {
      // Where an estimated payment would otherwise look like a fixed bill.
      // Down this column a variable payment priced from history and a fixed
      // rent are both a vendor, a cadence and a figure — the whole reason
      // SC-625 needed a third register rather than just an amount. The mark
      // takes the second line, replacing the base-currency equivalent, which
      // is what a bare figure would carry: converting a figure into another
      // currency says less about it than saying it is last February's.
      //
      // THE SAME SUBSTITUTION IS OWED TO THE `amount` COLUMN BELOW, AND THIS
      // COMMENT USED TO CLAIM THIS WAS THE ONLY PLACE IT WAS NEEDED. It is
      // the only place on a PHONE. The desktop table renders through
      // `columns`, not through here, so the claim was false on the wider of
      // the two layouts and true-looking in every test that rendered both.
      const estimate = payment.expectedAmount === null ? historyEstimates.get(payment.id) : null;
      return {
        label: vendorName(payment),
        sublabel: `${formatPaymentInterval(t, payment.intervalUnit, payment.intervalCount)} · ${directionLabel(payment.direction, t)}${payment.status === 'active' ? '' : ` · ${payment.status}`}`,
        value: (
          <Numeric
            value={estimate?.amount ?? payment.expectedAmount}
            currency={symbolFor(payment)}
          />
        ),
        delta: estimate ? (
          <EstimatedFromHistory sourceDueDate={estimate.sourceDueDate} />
        ) : (
          <BaseEquivalent
            amount={payment.expectedAmount}
            currencyTokenId={payment.currencyTokenId}
            rates={rates}
          />
        ),
      };
    },
    columns: [
      {
        key: 'vendor',
        headerKey: 'ui.dataView.payments.col.vendor',
        sortable: true,
        render: vendorName,
      },
      {
        key: 'direction',
        headerKey: 'ui.dataView.payments.col.direction',
        width: 'w-28',
        render: (payment) => directionLabel(payment.direction, t),
      },
      {
        key: 'cadence',
        headerKey: 'ui.dataView.payments.col.cadence',
        width: 'w-40',
        render: (payment) => formatPaymentInterval(t, payment.intervalUnit, payment.intervalCount),
      },
      {
        key: 'status',
        headerKey: 'ui.dataView.payments.col.status',
        sortable: true,
        width: 'w-28',
        render: (payment) => <StatusCell status={payment.status} />,
        exportValue: (payment) => exportText(payment.status),
      },
      {
        key: 'amount',
        headerKey: 'ui.dataView.payments.col.amount',
        sortable: true,
        numeric: true,
        width: 'w-36',
        // The table's own second line: the row keeps its currency here too, so
        // the column has to carry the equivalent that the phone row puts in its
        // delta zone — otherwise the same figure explains itself on a phone and
        // not on a desktop. That applies to the SC-625 mark before it applies
        // to the conversion: an estimate that announces its provenance on a
        // phone and renders as a bare figure on a desktop is the failure the
        // third register exists to prevent, on the layout most readers use.
        render: (payment) => {
          const estimate =
            payment.expectedAmount === null ? historyEstimates.get(payment.id) : null;
          return (
            <span className="flex flex-col items-end">
              <Numeric
                value={estimate?.amount ?? payment.expectedAmount}
                currency={symbolFor(payment)}
              />
              {estimate ? (
                <EstimatedFromHistory sourceDueDate={estimate.sourceDueDate} />
              ) : (
                <BaseEquivalent
                  amount={payment.expectedAmount}
                  currencyTokenId={payment.currencyTokenId}
                  rates={rates}
                />
              )}
            </span>
          );
        },
        // THE EXPORT DELIBERATELY CARRIES THE DECLARED AMOUNT ONLY, so an
        // estimated payment exports blank while its cell on screen shows a
        // figure. That is the one place the two are allowed to disagree.
        // `exportTotal` sums this column, and a workbook has no dashed
        // outline and no citation line to carry the third register — so an
        // estimate written here would be summed into a total as though it
        // were declared, which is exactly what the mark exists to prevent.
        // The screen can say "estimated"; a spreadsheet cell cannot.
        exportValue: (payment) =>
          exportMoneyInBase(
            payment.expectedAmount,
            payment.currencyTokenId,
            symbolFor(payment),
            rates
          ),
        exportTotal: true,
      },
    ],
    empty: {
      icon: Repeat,
      titleKey: 'ui.dataView.payments.empty.noRecurringPaymentsYet',
      descriptionKey:
        'ui.dataView.payments.empty.addABillOrRecurringIncomeAndScaniTracksEveryDateItFallsDue',
      action: (
        <Button asChild>
          <Link to={V3_PAYMENT_ROUTES.create}>{t('v3.money.recurringList.addPayment')}</Link>
        </Button>
      ),
    },
    peek: {
      basePath: V3_ROUTES.recurring,
      render: (payment) => {
        const unit = asPaymentIntervalUnit(payment.intervalUnit);
        const symbol = symbolFor(payment);
        // Same substitution as the row, and it has to be the same one: a peek
        // opened from a row showing a figure must not say "Varies".
        const estimate = payment.expectedAmount === null ? historyEstimates.get(payment.id) : null;
        const amount = payment.expectedAmount ?? estimate?.amount ?? null;
        const monthly = amount ? monthlyEquivalent(amount, unit, payment.intervalCount) : null;

        return {
          title: vendorName(payment),
          // Both halves are keys now: the cadence came out of v2 with SC-320,
          // and the frame joining it to the direction has been one since SC-235.
          subtitle: t('v3.money.peek.cadenceAndDirection', {
            cadence: formatPaymentInterval(t, payment.intervalUnit, payment.intervalCount),
            direction: directionLabel(payment.direction, t),
          }),
          // Words rather than `<Numeric>`'s placeholder when there is no
          // figure. A lone grey em dash where the headline amount goes is
          // indistinguishable from a skeleton that never resolved (SC-67), and
          // the two cases it covers are different answers: a variable payment
          // has no amount yet by design, and a fixed one that has none is a
          // record the form should never have written.
          value: amount ? (
            <Numeric value={amount} currency={symbol} />
          ) : (
            <span className="text-muted-foreground">
              {payment.kind === 'variable'
                ? t('v3.money.peek.setOnSettling')
                : t('v3.money.peek.noAmount')}
            </span>
          ),
          // `delta` shares the figure's own line and wraps under it — the
          // same slot the row uses, so the mark sits beside the number in both
          // places. `<ProjectedTile>`'s rule applies here too: a caveat that
          // scrolls away from the figure it qualifies is not a caveat.
          delta: estimate ? (
            <EstimatedFromHistory sourceDueDate={estimate.sourceDueDate} />
          ) : undefined,
          actions: (
            <>
              <Button asChild>
                <Link to={V3_PAYMENT_ROUTES.edit(payment.id)}>{t('v3.money.peek.edit')}</Link>
              </Button>
              <PaymentStatusToggle
                paymentId={payment.id}
                status={payment.status}
                pausedAt={payment.pausedAt}
              />
              <EndPaymentAction
                paymentId={payment.id}
                vendorName={vendorName(payment)}
                status={payment.status}
              />
              {/* Beside End, never instead of it. The two are different claims
                  — End retires a bill that really ran, Delete says it should
                  never have existed — and only the second one refuses when
                  there is settled money behind it (SC-83). */}
              <DeletePaymentAction
                paymentId={payment.id}
                vendorName={vendorName(payment)}
                status={payment.status}
              />
            </>
          ),
          primary: [
            {
              label: t('v3.money.peek.status'),
              // NOT extracted: the value is the raw `payments.status` enum with
              // a `capitalize` class on it. Capitalising a wire value is not a
              // translation, and giving it one means a status map — SC-235.
              value: <span className="capitalize">{payment.status}</span>,
            },
            {
              label: t('v3.money.peek.monthlyEquivalent'),
              // Annualised then divided by 12 — never a period amount scaled
              // up, or a fortnightly bill reads as 24 payments a year.
              //
              // "Varies" only where the amount actually varies. A fixed payment
              // with no amount used to read "Varies" here directly beside
              // "Amount is: Fixed", which is the record contradicting itself
              // rather than admitting the figure is missing (SC-67).
              value: monthly ? (
                <Numeric value={monthly.toString()} currency={symbol} />
              ) : payment.kind === 'variable' ? (
                t('v3.money.peek.varies')
              ) : (
                t('v3.money.peek.notSet')
              ),
            },
            // "Amount is", not "Amount" — the figure above the facts is the
            // amount, and a second row headed the same thing reads as a
            // contradiction rather than as the fixed/variable distinction.
            {
              label: t('v3.money.peek.amountIs'),
              value:
                payment.kind === 'variable' ? t('v3.money.peek.varies') : t('v3.money.peek.fixed'),
            },
            { label: t('v3.money.peek.started'), value: formatDate(payment.anchorDate) },
          ],
          sections: [
            {
              title: t('v3.money.peek.schedule'),
              facts: [
                {
                  label: t('v3.money.peek.repeats'),
                  value: formatPaymentInterval(t, payment.intervalUnit, payment.intervalCount),
                },
                { label: t('v3.money.peek.anchorDate'), value: formatDate(payment.anchorDate) },
                {
                  label: t('v3.money.peek.ends'),
                  value: payment.endDate ? formatDate(payment.endDate) : t('v3.money.peek.never'),
                },
                // Only while paused, and only when there is a real date to
                // show — it is the boundary the Resume action acts on, so
                // the reader can see the window before committing to it.
                ...(payment.status === 'paused' && payment.pausedAt
                  ? [
                      {
                        label: t('v3.money.peek.pausedSince'),
                        value: formatDate(payment.pausedAt.slice(0, 10)),
                      },
                    ]
                  : []),
              ],
            },
            ...(payment.notes
              ? [
                  {
                    title: t('v3.money.peek.notes'),
                    facts: [{ label: t('v3.money.peek.note'), value: payment.notes }],
                  },
                ]
              : []),
          ],
        };
      },
    },
  };

  return <V3DataView config={config} getId={(payment) => payment.id} query={query} />;
}
