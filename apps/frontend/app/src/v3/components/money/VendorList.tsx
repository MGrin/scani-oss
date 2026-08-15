import { type Decimal, formatDate } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { rowName, type V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { BLANK_CELL, exportConvertedMoney, exportCount } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { Store } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import type { RouterOutputs } from '@/lib/trpc';
import {
  COMMITMENT_LABEL,
  comparableBaseAmount,
  INCOME_COMMITMENT_LABEL,
  INFLOW,
  isIncomeVendor,
  monthlyCommitmentByVendor,
  noSettledSpend,
  PAID_ALL_TIME_LABEL,
  PER_MONTH_LABEL,
  paidWindowLabel,
  RECEIVED_ALL_TIME_LABEL,
  receivedWindowLabel,
  settledByVendor,
  settlementsByVendor,
  unpricedNote,
  type VendorDirectionKind,
  vendorDirectionKind,
  vendorDirectionKinds,
  vendorKindLabel,
} from '@/lib/vendorSpend';
import { convertTotalsToBase } from '@/v2/lib/paymentTotals';
import { countByVendorId } from '../../lib/money';
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
  creating,
  onCreatingChange,
}: VendorListProps) {
  const paymentCountByVendorId = useMemo(() => countByVendorId(payments), [payments]);
  const commitmentByVendorId = useMemo(() => monthlyCommitmentByVendor(payments), [payments]);
  const incomeByVendorId = useMemo(() => monthlyCommitmentByVendor(payments, INFLOW), [payments]);
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

  const countLabel = (vendor: VendorRow) => {
    const count = countFor(vendor);
    return `${count} payment${count === 1 ? '' : 's'}`;
  };

  const sublabelFor = (vendor: VendorRow) =>
    [vendor.category ?? 'Uncategorised', vendorKindLabel(kindFor(vendor)), countLabel(vendor)]
      .filter(Boolean)
      .join(' · ');

  const config: V3DataViewConfig<VendorRow> = {
    pageKey: 'vendors',
    noun: 'vendors',
    searchPlaceholder: 'Search vendors',
    data: vendors,
    searchFn: (vendor, query) => vendor.displayName.toLowerCase().includes(query),
    sortDefs: [
      { key: 'name', label: 'Name' },
      { key: 'spend', label: PER_MONTH_LABEL },
      { key: 'payments', label: 'Payments' },
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
        label: 'Category',
        fn: (vendor: VendorRow) => vendor.category ?? 'Uncategorised',
      },
      // Offered because the column mixes two directions: a reader who wants
      // only the bills, or only the income, can have them as their own
      // headed bands without either figure being netted into the other.
      {
        key: 'direction',
        label: 'Bills / income',
        fn: (vendor: VendorRow) => vendorKindLabel(kindFor(vendor)) ?? 'Bills',
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
        vendorKindLabel(kindFor(vendor)),
        countLabel(vendor),
      ]),
    }),
    // The phone list's answer to the desktop table's "Per month" header. The
    // summary above carries labelled totals, so a bare money column under it
    // belongs to none of them until it is named (SC-69 3.3). Direction-neutral
    // since SC-78 §5 — the rows below it are not all bills.
    valueHeader: PER_MONTH_LABEL,
    columns: [
      { key: 'name', header: 'Vendor', sortable: true, render: (vendor) => vendor.displayName },
      { key: 'category', header: 'Category', render: (vendor) => vendor.category ?? '—' },
      {
        key: 'direction',
        header: 'Kind',
        render: (vendor) => vendorKindLabel(kindFor(vendor)) ?? 'Bill',
      },
      {
        key: 'spend',
        // The period is in the header rather than in a tooltip: a money column
        // whose period has to be hovered for is a column of unlabelled figures.
        header: PER_MONTH_LABEL,
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
        header: 'Payments',
        sortable: true,
        numeric: true,
        width: 'w-28',
        render: (vendor) => <Numeric value={countFor(vendor)} format="plain" decimals={0} />,
        exportValue: (vendor) => exportCount(countFor(vendor)),
      },
    ],
    empty: {
      icon: Store,
      title: 'No vendors yet',
      description:
        'A vendor is created for you the first time you point a payment at one. You can also add one here.',
      action: <Button onClick={() => onCreatingChange(true)}>New vendor</Button>,
    },
    peek: {
      basePath: V3_ROUTES.vendors,
      render: (vendor) => {
        const kind = kindFor(vendor);
        const income = isIncomeVendor(kind);
        const settled = income ? receivedFor(vendor) : settledFor(vendor);
        const recent = (income ? recentIncomeByVendorId : recentByVendorId).get(vendor.id) ?? [];
        const unpriced = unpricedNote(settled.unpricedCount);
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
                    {countFor(vendor) === 1 ? 'See payment' : 'See payments'}
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
                  { label: PER_MONTH_LABEL, value: '—' },
                  { label: 'Payments', value: countFor(vendor) },
                ]
              : [
                  {
                    label: income ? INCOME_COMMITMENT_LABEL : COMMITMENT_LABEL,
                    value: rowFigure(vendor),
                  },
                  {
                    label: income
                      ? receivedWindowLabel(windowMonths)
                      : paidWindowLabel(windowMonths),
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
                    label: income ? RECEIVED_ALL_TIME_LABEL : PAID_ALL_TIME_LABEL,
                    value: (
                      <ConvertedFigure
                        totals={settled.allTime}
                        tokenSymbolById={tokenSymbolById}
                        rates={rates}
                        delta={income}
                      />
                    ),
                  },
                  { label: 'Payments', value: countFor(vendor) },
                ],
          sections: [
            // A vendor in both directions gets its income in a section of its
            // own — beside the bills, never folded into them.
            ...(alsoIncome
              ? [
                  {
                    title: 'Income from this vendor',
                    facts: [
                      {
                        label: INCOME_COMMITMENT_LABEL,
                        value: figure(incomeFor(vendor), true),
                      },
                      {
                        label: receivedWindowLabel(windowMonths),
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
                    title: income ? 'Recent income' : 'Recent payments',
                    facts: settlementFacts(recent),
                  },
                ]
              : []),
            {
              title: 'Details',
              facts: [
                { label: 'Website', value: vendor.website ?? 'None on file' },
                ...(kind === 'unclassified'
                  ? [
                      {
                        label: 'Direction',
                        value:
                          'This vendor’s payments do not say whether the money goes out or comes in, so no monthly figure is shown.',
                      },
                    ]
                  : []),
                ...(unpriced ? [{ label: 'Not counted', value: unpriced }] : []),
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
