import { type Decimal, formatDate } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { rowName, type V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { BLANK_CELL, exportConvertedMoney, exportCount } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { Store } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import type { RouterOutputs } from '@/lib/trpc';
import {
  commitmentLabel,
  comparableBaseAmount,
  INFLOW,
  incomeCommitmentLabel,
  isIncomeVendor,
  monthlyCommitmentByVendor,
  noSettledSpend,
  OUTFLOW,
  PER_MONTH_LABEL_KEY,
  paidAllTimeLabel,
  paidWindowLabel,
  perMonthLabel,
  receivedAllTimeLabel,
  receivedWindowLabel,
  settledByVendor,
  settlementsByVendor,
  unpricedNote,
  type VendorDirectionKind,
  vendorDirectionKind,
  vendorDirectionKinds,
  vendorKindLabel,
} from '@/lib/vendorSpend';
import { countByVendorId } from '../../lib/money';
import { convertTotalsToBase, type HistoryEstimate } from '../../lib/paymentTotals';
import { V3_ROUTES, vendorPaymentsPath } from '../../lib/routes';
import { BaseEquivalent } from '../BaseEquivalent';
import { ConvertedFigure } from '../ConvertedFigure';
import { DeleteVendorAction } from './DeleteVendorAction';
import { EditVendorAction } from './EditVendorAction';
import { MergeVendorAction } from './MergeVendorAction';
import { VendorCreateRow } from './VendorCreateRow';
import { VendorSpendSummary } from './VendorSpendSummary';

/**
 * Who the money goes to, and how much of it — the third view of the Money tab.
 *
 * v2 gave a vendor a whole page (`VendorDetailPage`, 165 lines) whose content
 * is a name, a category, a payment count and a merge dialog. In v3 all four are
 * a peek: the merge is an inline `ConfirmAction` in the sheet's action row
 * (V3-31), which is how v3 confirms a destructive write without stacking a
 * dialog on a half-height sheet.
 *
 * The row's figure is the vendor's **monthly commitment**, not what it has been
 * paid (V3-53). Both are real answers to "how much do I pay them", but only the
 * first is comparable down a column: a vendor set up last week has been paid
 * almost nothing and may still be the largest standing bill in the list, and a
 * list sorted on history would bury it. The historical figures — over a stated
 * window and over all time — are in the peek, where there is room to label
 * each one and to show the settlements behind them.
 *
 * **Every figure is direction-aware (SC-78 §5).** This surface used to ask
 * `monthlyCommitmentByVendor(payments)` and `settledByVendor(totals)` for the
 * outflow half only and print whatever came back, so an employer paying €5,850
 * a month rendered four €0.00 figures beside the words "Payments 1". The filter
 * was correct and the reporting was not: what a filter drops still has to be
 * accounted for. So the vendor is classified first (`vendorDirectionKinds`) and
 * the row then shows *its own* direction's figure under a label that matches —
 * income with `<Numeric delta>`'s sign, spend as a plain magnitude, and a
 * vendor that does both showing its bills with its income beside them in the
 * peek. Nothing on this surface adds the two together (V3-47).
 */

type VendorRow = RouterOutputs['vendors']['list'][number];
type PaymentRow = RouterOutputs['payments']['list'][number];
type VendorSpend = RouterOutputs['vendors']['spend'];

interface VendorListProps {
  vendors: VendorRow[];
  payments: PaymentRow[];
  /** `null` until `vendors.spend` resolves — the historical half is simply
   *  absent then, rather than rendered as a zero that will change. */
  spend: VendorSpend | null;
  tokenSymbolById: Map<string, string>;
  rates: BaseCurrencyRates;
  query: V3QueryState;
  /**
   * From `payments.forecast` (SC-625). A vendor's committed figure and the
   * recurring list's are the same claim about the same book two segments
   * apart, so they read the projection's estimates rather than each deciding
   * for themselves whether a variable payment counts.
   */
  historyEstimates: ReadonlyMap<string, HistoryEstimate>;
  /** Owned by the page, so the header's "New vendor" button can open it. */
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
}

export function VendorList({
  vendors,
  payments,
  spend,
  tokenSymbolById,
  rates,
  query,
  historyEstimates,
  creating,
  onCreatingChange,
}: VendorListProps) {
  const { t } = useTranslation();
  const paymentCountByVendorId = useMemo(() => countByVendorId(payments), [payments]);
  const commitmentByVendorId = useMemo(
    () => monthlyCommitmentByVendor(payments, OUTFLOW, historyEstimates),
    [payments, historyEstimates]
  );
  const incomeByVendorId = useMemo(
    () => monthlyCommitmentByVendor(payments, INFLOW, historyEstimates),
    [payments, historyEstimates]
  );
  const settledByVendorId = useMemo(() => settledByVendor(spend?.totals ?? []), [spend]);
  const receivedByVendorId = useMemo(() => settledByVendor(spend?.totals ?? [], INFLOW), [spend]);
  const recentByVendorId = useMemo(() => settlementsByVendor(spend?.recent ?? []), [spend]);
  const recentIncomeByVendorId = useMemo(
    () => settlementsByVendor(spend?.recent ?? [], INFLOW),
    [spend]
  );
  // Classified from BOTH sources: a vendor whose only standing payment ended
  // is still an employer, and its settled history says so.
  const kindByVendorId = useMemo(
    () => vendorDirectionKinds([...payments, ...(spend?.totals ?? [])]),
    [payments, spend]
  );
  const windowMonths = spend?.windowMonths ?? 12;

  const countFor = (vendor: VendorRow) => paymentCountByVendorId.get(vendor.id) ?? 0;
  const kindFor = (vendor: VendorRow): VendorDirectionKind =>
    vendorDirectionKind(kindByVendorId, vendor.id);
  // Every vendor gets a map, empty or not: "no payments" is €0.00 a month, and
  // a blank cell in a money column reads as a figure we failed to load. The
  // exception is `unclassified`, handled at the render site — there the zero
  // would be a claim we have no basis for.
  const commitmentFor = (vendor: VendorRow) =>
    commitmentByVendorId.get(vendor.id) ?? new Map<string, never>();
  const incomeFor = (vendor: VendorRow) =>
    incomeByVendorId.get(vendor.id) ?? new Map<string, never>();
  const settledFor = (vendor: VendorRow) => settledByVendorId.get(vendor.id) ?? noSettledSpend();
  const receivedFor = (vendor: VendorRow) => receivedByVendorId.get(vendor.id) ?? noSettledSpend();

  const figure = (totals: ReadonlyMap<string, Decimal>, delta: boolean) => (
    <ConvertedFigure
      totals={totals}
      tokenSymbolById={tokenSymbolById}
      rates={rates}
      delta={delta}
    />
  );

  /** The one figure a row shows: its own direction's, or nothing at all when
   *  we cannot tell which direction that is. */
  const rowFigure = (vendor: VendorRow) => {
    const kind = kindFor(vendor);
    if (kind === 'unclassified') {
      return <span className="text-muted-foreground">—</span>;
    }
    return isIncomeVendor(kind)
      ? figure(incomeFor(vendor), true)
      : figure(commitmentFor(vendor), false);
  };

  /** What the column sorts on — the magnitude of the figure the row actually
   *  shows, so the order matches what is on screen. */
  const rowSortValue = (vendor: VendorRow) => {
    const kind = kindFor(vendor);
    if (kind === 'unclassified') return 0;
    return comparableBaseAmount(
      isIncomeVendor(kind) ? incomeByVendorId.get(vendor.id) : commitmentByVendorId.get(vendor.id),
      rates
    );
  };

  const countLabel = (vendor: VendorRow) =>
    t('v3.money.vendorList.paymentCount', { count: countFor(vendor) });

  const sublabelFor = (vendor: VendorRow) =>
    [
      vendor.category ?? t('v3.money.vendorList.uncategorised'),
      vendorKindLabel(t, kindFor(vendor)),
      countLabel(vendor),
    ]
      .filter(Boolean)
      .join(' · ');

  const config: V3DataViewConfig<VendorRow> = {
    pageKey: 'vendors',
    nounKey: 'ui.dataView.noun.vendors',
    searchPlaceholderKey: 'ui.dataView.vendors.config.searchVendors',
    data: vendors,
    searchFn: (vendor, query) => vendor.displayName.toLowerCase().includes(query),
    sortDefs: [
      { key: 'name', labelKey: 'ui.dataView.vendors.sort.name' },
      { key: 'spend', labelKey: PER_MONTH_LABEL_KEY },
      { key: 'payments', labelKey: 'ui.dataView.vendors.sort.payments' },
    ],
    sortFn: (a, b, field, direction) => {
      const mult = direction === 'asc' ? 1 : -1;
      switch (field) {
        case 'name':
          return a.displayName.localeCompare(b.displayName) * mult;
        case 'spend':
          return (rowSortValue(a) - rowSortValue(b)) * mult;
        case 'payments':
          return (countFor(a) - countFor(b)) * mult;
        default:
          return 0;
      }
    },
    groupByDefs: [
      {
        key: 'category',
        labelKey: 'ui.dataView.vendors.group.category',
        fn: (vendor: VendorRow) => vendor.category ?? t('v3.money.vendorList.uncategorised'),
      },
      // Offered because the column mixes two directions: a reader who wants
      // only the bills, or only the income, can have them as their own
      // headed bands without either figure being netted into the other.
      {
        key: 'direction',
        labelKey: 'ui.dataView.vendors.group.billsIncome',
        fn: (vendor: VendorRow) =>
          vendorKindLabel(t, kindFor(vendor)) ?? t('v3.money.vendorList.billsGroup'),
      },
    ],
    defaultSort: { field: 'name', direction: 'asc' },
    summary: (items) => (
      <VendorSpendSummary
        commitment={items.filter((vendor) => !isIncomeVendor(kindFor(vendor))).map(commitmentFor)}
        paidInWindow={items.map((vendor) => settledFor(vendor).inWindow)}
        expectedIncome={items.map(incomeFor)}
        windowMonths={windowMonths}
        unpricedCount={items.reduce(
          (sum, vendor) =>
            sum + settledFor(vendor).unpricedCount + receivedFor(vendor).unpricedCount,
          0
        )}
        tokenSymbolById={tokenSymbolById}
        rates={rates}
      />
    ),
    renderRow: (vendor) => ({
      label: vendor.displayName,
      sublabel: sublabelFor(vendor),
      value: rowFigure(vendor),
      // The direction goes in the name, not the category: two rows telling
      // VoiceOver the same count differ by which way the money moves.
      ariaLabel: rowName([
        vendor.displayName,
        vendorKindLabel(t, kindFor(vendor)),
        countLabel(vendor),
      ]),
    }),
    // The phone list's answer to the desktop table's "Per month" header. The
    // summary above carries labelled totals, so a bare money column under it
    // belongs to none of them until it is named (SC-69 3.3). Direction-neutral
    // since SC-78 §5 — the rows below it are not all bills.
    valueHeaderKey: PER_MONTH_LABEL_KEY,
    columns: [
      {
        key: 'name',
        headerKey: 'ui.dataView.vendors.col.vendor',
        sortable: true,
        render: (vendor) => vendor.displayName,
      },
      {
        key: 'category',
        headerKey: 'ui.dataView.vendors.col.category',
        render: (vendor) => vendor.category ?? '—',
      },
      {
        key: 'direction',
        headerKey: 'ui.dataView.vendors.col.kind',
        render: (vendor) =>
          vendorKindLabel(t, kindFor(vendor)) ?? t('v3.money.vendorList.billKind'),
      },
      {
        key: 'spend',
        // The period is in the header rather than in a tooltip: a money column
        // whose period has to be hovered for is a column of unlabelled figures.
        headerKey: PER_MONTH_LABEL_KEY,
        sortable: true,
        numeric: true,
        width: 'w-40',
        render: rowFigure,
        // The base-currency total the row shows, not the per-currency parts
        // behind it: `ConvertedFigure` sums a map through SC-60's rates and
        // prints one figure, and the file carries that same figure so the two
        // cannot disagree. A vendor whose currency has no recent rate keeps its
        // unconverted remainder out of both, which is what the screen's
        // "+ 1 currency" note is there to say.
        exportValue: (vendor) => {
          const kind = kindFor(vendor);
          if (kind === 'unclassified') return BLANK_CELL;
          const totals = isIncomeVendor(kind) ? incomeFor(vendor) : commitmentFor(vendor);
          return exportConvertedMoney(
            convertTotalsToBase(totals, rates).amount.toString(),
            rates.baseSymbol
          );
        },
      },
      {
        key: 'payments',
        headerKey: 'ui.dataView.vendors.col.payments',
        sortable: true,
        numeric: true,
        width: 'w-28',
        render: (vendor) => <Numeric value={countFor(vendor)} format="plain" decimals={0} />,
        exportValue: (vendor) => exportCount(countFor(vendor)),
      },
    ],
    empty: {
      icon: Store,
      titleKey: 'ui.dataView.vendors.empty.noVendorsYet',
      descriptionKey: 'ui.dataView.vendors.empty.aVendorIsCreatedForYou',
      action: (
        <Button onClick={() => onCreatingChange(true)}>{t('v3.money.vendorPeek.newVendor')}</Button>
      ),
    },
    peek: {
      basePath: V3_ROUTES.vendors,
      render: (vendor) => {
        const kind = kindFor(vendor);
        const income = isIncomeVendor(kind);
        const settled = income ? receivedFor(vendor) : settledFor(vendor);
        const recent = (income ? recentIncomeByVendorId : recentByVendorId).get(vendor.id) ?? [];
        const unpriced = unpricedNote(t, settled.unpricedCount);
        const alsoIncome = kind === 'both';
        const incomeSettled = receivedFor(vendor);
        const incomeRecent = recentIncomeByVendorId.get(vendor.id) ?? [];

        const settlementFacts = (rows: typeof recent) =>
          rows.map((settlement) => ({
            label: formatDate(settlement.dueDate),
            value: (
              <>
                <Numeric
                  value={settlement.amount}
                  currency={tokenSymbolById.get(settlement.currencyTokenId) ?? rates.baseSymbol}
                />{' '}
                <BaseEquivalent
                  amount={settlement.amount}
                  currencyTokenId={settlement.currencyTokenId}
                  rates={rates}
                />
              </>
            ),
          }));

        return {
          title: vendor.displayName,
          subtitle: vendor.category ?? 'Uncategorised',
          value: rowFigure(vendor),
          actions: (
            <>
              {/* First, because renaming is the thing a reader opens a vendor
                  to do and until SC-83 the API could not do it at all. */}
              <EditVendorAction
                vendorId={vendor.id}
                displayName={vendor.displayName}
                category={vendor.category}
                website={vendor.website}
              />
              {/* The peek stated "Payments N" and offered no way to reach any
                  of them, so the only route from a vendor to a payment's Edit
                  was typing a URL (SC-83 2). Hidden at zero: a link to an
                  empty filtered list is a dead end wearing a button. */}
              {countFor(vendor) > 0 ? (
                <Button variant="outline" asChild>
                  <Link to={vendorPaymentsPath(vendor.id)}>
                    {t('v3.money.vendorPeek.seePayments', { count: countFor(vendor) })}
                  </Link>
                </Button>
              ) : null}
              <MergeVendorAction
                vendorId={vendor.id}
                vendorName={vendor.displayName}
                // The open record is always the survivor, so it is never its
                // own candidate.
                candidates={vendors.filter((candidate) => candidate.id !== vendor.id)}
              />
              {/* Last, and the only one that refuses: a vendor with payments
                  behind it cannot be deleted, because those payments and
                  everything settled against them are the history. */}
              <DeleteVendorAction vendorId={vendor.id} vendorName={vendor.displayName} />
            </>
          ),
          // Committed (or expected) first, then what has actually settled.
          // Three money facts rather than one because they are three different
          // claims, and the reader is owed the window each is measured over —
          // and the words have to match the direction, or the figure is filed
          // under a claim it does not make.
          primary:
            kind === 'unclassified'
              ? [
                  { label: perMonthLabel(t), value: '—' },
                  { label: t('v3.money.vendorPeek.payments'), value: countFor(vendor) },
                ]
              : [
                  {
                    label: income ? incomeCommitmentLabel(t) : commitmentLabel(t),
                    value: rowFigure(vendor),
                  },
                  {
                    label: income
                      ? receivedWindowLabel(t, windowMonths)
                      : paidWindowLabel(t, windowMonths),
                    value: (
                      <ConvertedFigure
                        totals={settled.inWindow}
                        tokenSymbolById={tokenSymbolById}
                        rates={rates}
                        delta={income}
                      />
                    ),
                  },
                  {
                    label: income ? receivedAllTimeLabel(t) : paidAllTimeLabel(t),
                    value: (
                      <ConvertedFigure
                        totals={settled.allTime}
                        tokenSymbolById={tokenSymbolById}
                        rates={rates}
                        delta={income}
                      />
                    ),
                  },
                  { label: t('v3.money.vendorPeek.payments'), value: countFor(vendor) },
                ],
          sections: [
            // A vendor in both directions gets its income in a section of its
            // own — beside the bills, never folded into them.
            ...(alsoIncome
              ? [
                  {
                    title: t('v3.money.vendorPeek.incomeFromThisVendor'),
                    facts: [
                      {
                        label: incomeCommitmentLabel(t),
                        value: figure(incomeFor(vendor), true),
                      },
                      {
                        label: receivedWindowLabel(t, windowMonths),
                        value: (
                          <ConvertedFigure
                            totals={incomeSettled.inWindow}
                            tokenSymbolById={tokenSymbolById}
                            rates={rates}
                            delta
                          />
                        ),
                      },
                      ...(incomeRecent.length > 0 ? settlementFacts(incomeRecent) : []),
                    ],
                  },
                ]
              : []),
            ...(recent.length > 0
              ? [
                  {
                    title: income
                      ? t('v3.money.vendorPeek.recentIncome')
                      : t('v3.money.vendorPeek.recentPayments'),
                    facts: settlementFacts(recent),
                  },
                ]
              : []),
            {
              title: t('v3.money.vendorPeek.details'),
              facts: [
                {
                  label: t('v3.money.vendorPeek.website'),
                  value: vendor.website ?? t('v3.money.vendorPeek.noWebsite'),
                },
                ...(kind === 'unclassified'
                  ? [
                      {
                        label: t('v3.money.vendorPeek.direction'),
                        value: t('v3.money.vendorPeek.unclassified'),
                      },
                    ]
                  : []),
                ...(unpriced
                  ? [{ label: t('v3.money.vendorPeek.notCounted'), value: unpriced }]
                  : []),
              ],
            },
          ],
        };
      },
    },
  };

  return (
    <div className="flex flex-col gap-4">
      {creating ? <VendorCreateRow onDone={() => onCreatingChange(false)} /> : null}
      <V3DataView config={config} getId={(vendor) => vendor.id} query={query} />
    </div>
  );
}
