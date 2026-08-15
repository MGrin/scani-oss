import type { HoldingWithDetails } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { BulkDeleteAction } from '@scani/ui/v3/components/data-view/BulkDeleteAction';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { nameList, rowName, type V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { exportMoney, exportNumber, exportPercent, exportText } from '@scani/ui/v3/lib/export/cell';
import { resolveNumeric } from '@scani/ui/v3/lib/numeric';
import { PieChart, Tags } from 'lucide-react';
import {
  amountDecimals,
  compareHoldings,
  entityOptions,
  holdingGainLoss,
  holdingMatches,
  holdingPrice,
  tokenTypeOptions,
} from '../../lib/holdings';
import { V3_ROUTES } from '../../lib/routes';
import { InstitutionMark } from '../entities/InstitutionMark';
import { HoldingsSummary } from './HoldingsSummary';
import {
  type HoldingPeekContext,
  holdingAmount,
  holdingPeekSpec,
  holdingRowDelta,
} from './holdingPeek';

/**
 * What the holdings list *is* — separated from the page, which is the queries,
 * the dialogs and the mutations that feed it.
 *
 * The split is here rather than inline because this object is the ticket: which
 * fields a row carries, which columns a desktop gets, which dimensions the list
 * can be sliced by. Keeping it a function of already-resolved data means it can
 * be exercised against fixtures — every state of it, including the ones a
 * seeded database will not produce on demand.
 *
 * The IA change from §2.1 lives in `filterDefs` and `groupByDefs`: institution
 * and account are both a filter and a group-by here, which is what it means for
 * them to stop being destinations and become dimensions of this list.
 */

interface Named {
  id: string;
  name: string;
}

export interface HoldingsConfigInput {
  holdings: HoldingWithDetails[];
  /** Base-currency symbol or code. */
  currency: string;
  /** The full institution / account / group lists. Undefined until they land;
   *  the holdings themselves are the fallback. */
  institutions: readonly Named[] | undefined;
  accounts: readonly Named[] | undefined;
  groups: readonly Named[] | undefined;
  /** Seeded from the URL — see `holdingFiltersFromParams`. */
  defaultFilters: Record<string, string>;
  peek: HoldingPeekContext;
  onAssignGroups: (ids: string[], clearSelection: () => void) => void;
  onBulkDelete: (ids: string[], clearSelection: () => void) => void;
  /** True while `holdings.bulkDelete` is in flight — disables the commit so a
   *  second tap cannot re-send a delete that is already running. */
  isBulkDeleting?: boolean;
  /** Raises the capture sheet for the empty state's call to action. Passed in
   *  rather than read here because this is a plain function, not a component,
   *  and the opener is a hook (`useOpenCapture`, V3-14). */
  onAddData: () => void;
}

/**
 * The institution's mark. `InstitutionMark` (V3-15) owns the fallback and why
 * it is mandatory; accounts and institutions render the same thing.
 */
function InstitutionIcon({
  institution,
  size,
}: {
  institution: HoldingWithDetails['institution'];
  size: string;
}) {
  return <InstitutionMark name={institution.name} website={institution.website} size={size} />;
}

/**
 * The symbols behind a selection, in the list's own order so the sentence
 * reads in the order the rows do. Exported for the same reason the bulk
 * confirmation exists at all — the claim "you are about to delete these three"
 * is only worth making if it is checkable.
 */
export function selectedSymbols(
  holdings: readonly HoldingWithDetails[],
  selectedIds: ReadonlySet<string>
): string {
  return nameList(
    holdings.filter((item) => selectedIds.has(item.id)).map((item) => item.token.symbol)
  );
}

function InstitutionCell({ holding }: { holding: HoldingWithDetails }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <InstitutionIcon institution={holding.institution} size="size-4" />
      <span className="truncate">{holding.institution.name}</span>
    </span>
  );
}

/**
 * Why this row's value is a dash.
 *
 * `value === null` is two facts wearing one face: "we could not fetch a price
 * today" (temporary, retryable, and the row will fill in) and "no provider has
 * ever quoted this token and we have stopped asking" (permanent until a
 * provider starts). SC-146 taught the net-worth chart to leave the second kind
 * out of its coverage denominator and to say HOW MANY it set aside; this says
 * WHICH, which is the half the chart cannot (SC-154).
 *
 * Not an error style. Fourteen airdrop tokens being unpriceable is the normal
 * state of a wallet that has been airdropped at, not a fault the reader has to
 * act on — so it reads as a label, in the same muted register as `Inactive`.
 */
function UnpriceableBadge() {
  return (
    <Badge
      variant="secondary"
      className="shrink-0"
      title="No price source has ever quoted this token, and we have stopped asking for now. It is left out of your net worth rather than counted as zero."
    >
      No price
    </Badge>
  );
}

export function holdingsDataViewConfig({
  holdings,
  currency,
  institutions,
  accounts,
  groups,
  defaultFilters,
  peek,
  onAssignGroups,
  onBulkDelete,
  isBulkDeleting,
  onAddData,
}: HoldingsConfigInput): V3DataViewConfig<HoldingWithDetails> {
  return {
    pageKey: 'holdings',
    data: holdings,
    noun: 'holdings',
    // Short, because at 393px it shares the row with Refine and Select and a
    // truncated placeholder is a placeholder that no longer explains anything.
    searchPlaceholder: 'Search holdings',
    searchFn: holdingMatches,
    defaultFilters,
    defaultSort: { field: 'value', direction: 'desc' },
    filterDefs: [
      {
        key: 'tokenType',
        label: 'Type',
        options: tokenTypeOptions(holdings),
        fn: (item: HoldingWithDetails, value) => item.token.typeCode === value,
      },
      {
        key: 'institution',
        label: 'Institution',
        options: entityOptions(
          institutions,
          holdings.map((item) => item.institution)
        ),
        fn: (item: HoldingWithDetails, value) => item.institution.id === value,
      },
      {
        key: 'account',
        label: 'Account',
        options: entityOptions(
          accounts,
          holdings.map((item) => item.account)
        ),
        fn: (item: HoldingWithDetails, value) => item.account.id === value,
      },
      {
        key: 'group',
        label: 'Group',
        options: (groups ?? []).map((group) => ({ value: group.id, label: group.name })),
        fn: (item: HoldingWithDetails, value) => item.groups.some((g) => g.id === value),
      },
    ],
    sortDefs: [
      { key: 'value', label: 'Value' },
      { key: 'symbol', label: 'Symbol' },
      { key: 'amount', label: 'Amount' },
      { key: 'price', label: 'Price' },
      { key: 'pnl', label: 'Gain / loss' },
    ],
    sortFn: compareHoldings,
    // The IA change, made concrete: the two destinations that lost their tab
    // are the first two ways to slice this list.
    groupByDefs: [
      {
        key: 'institution',
        label: 'Institution',
        fn: (item: HoldingWithDetails) => item.institution.name,
      },
      { key: 'account', label: 'Account', fn: (item: HoldingWithDetails) => item.account.name },
      {
        key: 'tokenType',
        label: 'Type',
        fn: (item: HoldingWithDetails) => item.token.type || item.token.typeCode,
      },
    ],
    summary: (items) => <HoldingsSummary holdings={items} currency={currency} />,
    renderRow: (item) => ({
      // The institution, as a favicon rather than a word: it is the second
      // thing you check about a position and the cheapest 20px on the row.
      // The account goes in the sublabel, so the two rows for the same token
      // in two accounts are still told apart.
      leading: <InstitutionIcon institution={item.institution} size="size-5" />,
      label:
        item.isActive && !item.unpriceable ? (
          item.token.symbol
        ) : (
          <span className="flex items-center gap-2">
            {item.token.symbol}
            {item.isActive ? null : <Badge variant="secondary">Inactive</Badge>}
            {item.unpriceable ? <UnpriceableBadge /> : null}
          </span>
        ),
      sublabel: `${item.token.name} · ${item.account.name}`,
      value: <Numeric value={item.value} currency={currency} />,
      delta: holdingRowDelta(item),
      // Account and value included (SC-71 7.2): two rows for the same token in
      // two accounts are told apart on screen by exactly those two things, and
      // named `BTC, Bitcoin` alike without them.
      ariaLabel: rowName([
        item.token.symbol,
        item.token.name,
        item.account.name,
        item.isActive ? null : 'inactive',
        // Read out with the row, not hidden in a tooltip: on a screen reader
        // the dash and the badge are the same silence otherwise.
        item.unpriceable ? 'no price available' : null,
        resolveNumeric(item.value, { currency }).text,
      ]),
    }),
    columns: [
      {
        key: 'symbol',
        header: 'Holding',
        sortable: true,
        width: 'w-[22%]',
        render: (item) => (
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-label">{item.token.symbol}</span>
              {item.isActive ? null : (
                <Badge variant="secondary" className="shrink-0">
                  Inactive
                </Badge>
              )}
              {item.unpriceable ? <UnpriceableBadge /> : null}
            </span>
            <span className="truncate text-caption text-muted-foreground">{item.token.name}</span>
          </span>
        ),
        // The symbol, declared rather than recovered: the cell's own text is
        // spread across nested elements the walker in `lib/export/data-view`
        // deliberately does not reach into. The symbol is what identifies the
        // row; the token name beside it on screen is a gloss on the symbol, and
        // a spreadsheet column holding "BTC Bitcoin" is worse than one holding
        // "BTC" for every use anyone puts this file to.
        exportValue: (item) => exportText(item.token.symbol),
      },
      {
        key: 'account',
        header: 'Account',
        width: 'w-[16%]',
        render: (item) => <span className="truncate">{item.account.name}</span>,
      },
      {
        key: 'institution',
        header: 'Institution',
        width: 'w-[16%]',
        render: (item) => <InstitutionCell holding={item} />,
        exportValue: (item) => exportText(item.institution.name),
      },
      {
        key: 'amount',
        header: 'Amount',
        sortable: true,
        numeric: true,
        render: (item) => holdingAmount(item),
        // The raw unit count, not the rounded display figure: a balance is the
        // one column where the digits the row hides are the ones an accountant
        // wants.
        exportValue: (item) => exportNumber(item.amount, amountDecimals(item.amount)),
      },
      {
        key: 'price',
        header: 'Price',
        sortable: true,
        numeric: true,
        render: (item) => <Numeric value={holdingPrice(item)} currency={currency} />,
        exportValue: (item) => exportMoney(holdingPrice(item), currency),
      },
      {
        key: 'value',
        header: 'Value',
        sortable: true,
        numeric: true,
        render: (item) => <Numeric value={item.value} currency={currency} />,
        exportValue: (item) => exportMoney(item.value, currency),
        exportTotal: true,
      },
      {
        key: 'pnl',
        header: 'Gain / loss',
        sortable: true,
        numeric: true,
        width: 'w-[12%]',
        render: (item) => holdingRowDelta(item) ?? <span className="text-muted-foreground">—</span>,
        exportValue: (item) => exportPercent(holdingGainLoss(item)?.percent),
      },
    ],
    empty: {
      icon: PieChart,
      title: 'No holdings yet',
      description:
        'Connect an exchange, import a statement or add a position by hand — all three land here.',
      // The capture sheet, not a link: this description names three ways in
      // and the sheet is the thing that lists all of them. Capture stopped
      // being a route in V3-14 — it opens over whatever you are reading, so
      // an empty holdings list is still behind it when the sheet is dismissed.
      action: <Button onClick={onAddData}>Add your first holding</Button>,
    },
    peek: {
      basePath: V3_ROUTES.holdings,
      render: (item) => holdingPeekSpec(item, peek),
    },
    renderBulkActions: (selectedIds, clearSelection) => (
      <>
        <Button variant="outline" onClick={() => onAssignGroups([...selectedIds], clearSelection)}>
          <Tags className="mr-2 size-4" aria-hidden="true" />
          Assign groups
        </Button>
        <BulkDeleteAction
          count={selectedIds.size}
          noun="holdings"
          isPending={isBulkDeleting}
          consequence={`${selectedSymbols(holdings, selectedIds)} ${selectedIds.size === 1 ? 'is' : 'are'} removed from your portfolio, and every transaction recorded against ${selectedIds.size === 1 ? 'it' : 'them'} goes too. This cannot be undone.`}
          onConfirm={() => onBulkDelete([...selectedIds], clearSelection)}
        />
      </>
    ),
  };
}
