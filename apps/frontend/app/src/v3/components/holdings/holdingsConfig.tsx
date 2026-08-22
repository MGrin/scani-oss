import type { HoldingWithDetails } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { BulkDeleteAction } from '@scani/ui/v3/components/data-view/BulkDeleteAction';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { nameList, rowName, type V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { exportMoney, exportNumber, exportPercent, exportText } from '@scani/ui/v3/lib/export/cell';
import { resolveNumeric } from '@scani/ui/v3/lib/numeric';
import type { TFunction } from 'i18next';
import { PieChart, Tags } from 'lucide-react';
import {
  type DataQualitySets,
  dataQualityOptions,
  HOLDINGS_QUALITY_PARAM,
  qualityFilterFn,
} from '../../lib/dataQuality';
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
import { LookalikeBadge } from './LookalikeBadge';

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
  /**
   * The holding ids behind each data-quality kind, from
   * `portfolio.getDataQualityReport` (SC-293).
   *
   * Undefined until the report lands, and undefined forever if it fails —
   * either way the filter simply is not offered. The list is not diagnostics
   * about itself, and a Holdings page that will not render because a counter
   * query 500'd would be a worse trade than a missing filter.
   */
  qualitySets: DataQualitySets | undefined;
  peek: HoldingPeekContext;
  /** Same instance the peek context carries — the config builds labels and the
   *  peek builds facts, and two `t`s would be two places for a key to rot. */
  t: TFunction;
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
  return <InstitutionMark name={institution.name} institution={institution} size={size} />;
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
function UnpriceableBadge({ t }: { t: TFunction }) {
  return (
    <Badge variant="secondary" className="shrink-0" title={t('v3.holdings.badge.noPriceTitle')}>
      {t('v3.holdings.badge.noPrice')}
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
  qualitySets,
  peek,
  onAssignGroups,
  onBulkDelete,
  isBulkDeleting,
  onAddData,
  t,
}: HoldingsConfigInput): V3DataViewConfig<HoldingWithDetails> {
  const inQualitySet = qualityFilterFn(qualitySets);
  const qualityMatches = (item: HoldingWithDetails, value: string) => inQualitySet(item.id, value);

  return {
    pageKey: 'holdings',
    data: holdings,
    nounKey: 'ui.dataView.noun.holdings',
    // Short, because at 393px it shares the row with Refine and Select and a
    // truncated placeholder is a placeholder that no longer explains anything.
    searchPlaceholderKey: 'ui.dataView.holdings.config.searchHoldings',
    searchFn: holdingMatches,
    defaultFilters,
    defaultSort: { field: 'value', direction: 'desc' },
    filterDefs: [
      {
        key: 'tokenType',
        labelKey: 'ui.dataView.holdings.filter.type',
        options: tokenTypeOptions(holdings),
        fn: (item: HoldingWithDetails, value) => item.token.typeCode === value,
      },
      {
        key: 'institution',
        labelKey: 'ui.dataView.holdings.filter.institution',
        options: entityOptions(
          institutions,
          holdings.map((item) => item.institution)
        ),
        fn: (item: HoldingWithDetails, value) => item.institution.id === value,
      },
      {
        key: 'account',
        labelKey: 'ui.dataView.holdings.filter.account',
        options: entityOptions(
          accounts,
          holdings.map((item) => item.account)
        ),
        fn: (item: HoldingWithDetails, value) => item.account.id === value,
      },
      {
        key: 'group',
        labelKey: 'ui.dataView.holdings.filter.group',
        options: (groups ?? []).map((group) => ({ value: group.id, label: group.name })),
        fn: (item: HoldingWithDetails, value) => item.groups.some((g) => g.id === value),
      },
      {
        /**
         * The data-quality dimension (SC-293) — where the Settings panel's
         * flagged rows land.
         *
         * The predicate is an ID-SET LOOKUP, not a re-derivation. A local
         * `item.amount === 0` would be a second implementation of a rule the
         * server already applied, and the two disagreeing is precisely the
         * defect this filter exists to close: the panel says 12 and the list
         * it opens shows 11, with nothing on either screen admitting which is
         * wrong. One rule, computed once, on the side that can see coverage
         * rows and price history at all.
         *
         * Its options are the kinds this reader actually has, so the sheet
         * never offers a slice that selects nothing.
         */
        key: HOLDINGS_QUALITY_PARAM,
        labelKey: 'ui.dataView.holdings.filter.quality',
        options: dataQualityOptions(qualitySets),
        fn: qualityMatches,
      },
    ],
    sortDefs: [
      { key: 'value', labelKey: 'ui.dataView.holdings.sort.value' },
      { key: 'symbol', labelKey: 'ui.dataView.holdings.sort.symbol' },
      { key: 'amount', labelKey: 'ui.dataView.holdings.sort.amount' },
      { key: 'price', labelKey: 'ui.dataView.holdings.sort.price' },
      { key: 'pnl', labelKey: 'ui.dataView.holdings.sort.pnl' },
    ],
    sortFn: compareHoldings,
    // The IA change, made concrete: the two destinations that lost their tab
    // are the first two ways to slice this list.
    groupByDefs: [
      {
        key: 'institution',
        labelKey: 'ui.dataView.holdings.groupBy.institution',
        fn: (item: HoldingWithDetails) => item.institution.name,
      },
      {
        key: 'account',
        labelKey: 'ui.dataView.holdings.groupBy.account',
        fn: (item: HoldingWithDetails) => item.account.name,
      },
      {
        key: 'tokenType',
        labelKey: 'ui.dataView.holdings.groupBy.type',
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
        item.isActive && !item.unpriceable && !item.token.lookalikeOf ? (
          item.token.symbol
        ) : (
          // `min-w-0` on the row and `truncate` on the symbol, so the SYMBOL
          // is what gives up space and the badges survive. DataRow wraps this
          // label in `block truncate` (overflow:hidden, nowrap), so without
          // `min-w-0` the whole flex row overflows and is clipped from the
          // right — which silently removed whichever badge came last at 390px.
          //
          // Lookalike first, immediately after the symbol it qualifies. It is
          // the only one of the three that is a fact about the token rather
          // than about our coverage, so it is the one that must not lose a
          // space contest to `No price`. Adjacency and survival are the same
          // property here.
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{item.token.symbol}</span>
            {item.token.lookalikeOf ? (
              <LookalikeBadge
                symbol={item.token.symbol}
                impersonates={item.token.lookalikeOf}
                t={t}
              />
            ) : null}
            {item.isActive ? null : (
              <Badge variant="secondary" className="shrink-0">
                {t('v3.holdings.peek.inactive')}
              </Badge>
            )}
            {item.unpriceable ? <UnpriceableBadge t={t} /> : null}
          </span>
        ),
      // The pot's name sits between the token and the account, because that
      // is the level it distinguishes at: four rows reading `Russian Ruble ·
      // Tinkoff` are four rows nobody can tell apart, and the user named them
      // precisely so they could (SC-330).
      sublabel: item.label
        ? `${item.token.name} · ${item.label} · ${item.account.name}`
        : `${item.token.name} · ${item.account.name}`,
      // Two figures, deliberately unequal (SC-559). The base-currency value
      // is the headline and keeps the row's `text-label`; the unit count sits
      // under it in caption ink, carrying the SYMBOL it counts — a bare
      // `0.00000142` answers nothing, and the symbol is what makes it a
      // quantity rather than a number. No lookalike badge here: the row's
      // identity zone already carries one against the symbol it qualifies,
      // and two on one row read as two different claims.
      value: (
        <span className="flex min-w-0 flex-col items-end">
          <Numeric value={item.value} currency={currency} />
          <span className="flex min-w-0 items-baseline gap-1 text-caption text-muted-foreground">
            {holdingAmount(item, t)}
            {/* The unit, and the ONE thing in this zone allowed to give way.
                Measured at 393px before it was bounded: `GRAPHICS PROCESSING
                UNITS` is a real 25-character symbol in this portfolio, and
                spelling it out here took the value zone to 198px against 87px
                of identity — an unreadable account name on every row of that
                token, in the zone whose whole job is saying which row this is.

                Truncating it costs nothing, which is what makes it the right
                thing to cut rather than the convenient one: the row's identity
                zone carries the SAME symbol in full, at row weight, with its
                lookalike badge, one line to the left. This is an annotation on
                the figure, not the figure — the figure never truncates, and
                does not here.

                THE FIGURE'S WORST CASE IS ANSWERED, and not by relaxing the
                rule above. It used to be invisible: `HoldingQueryService`
                rounded `amount` to 8 dp, so a dust balance arrived as `0` and
                every measurement here was taken on a short figure. Measured
                with the real wire at 393px, `0.000000000000000001 CHF` puts
                the value zone at 182px against 103px of identity and clips the
                account name — nothing overflows, `main.scrollWidth` stays 393,
                but the identity zone loses the thing it exists to say.

                So a balance too small for the column renders `< 0.00000001`
                here (`holdingAmount`, SC-567). That is a THRESHOLD, not a
                truncation — complete and true, where a cut-off figure would be
                ambiguous — so the figure still never gives way, and the symbol
                is still the only thing in this zone that does. The peek and
                the export carry the exact digits; this row is scanned. */}
            <span className="max-w-[6ch] truncate">{item.token.symbol}</span>
          </span>
        </span>
      ),
      delta: holdingRowDelta(item),
      // Account and value included (SC-71 7.2): two rows for the same token in
      // two accounts are told apart on screen by exactly those two things, and
      // named `BTC, Bitcoin` alike without them.
      ariaLabel: rowName([
        item.token.symbol,
        item.token.name,
        // Spoken with the row for the same reason it is drawn: without it a
        // screen reader reads four identical rows.
        item.label ?? null,
        item.account.name,
        item.isActive ? null : 'inactive',
        // Read out with the row, not hidden in a tooltip: on a screen reader
        // the dash and the badge are the same silence otherwise.
        item.unpriceable ? t('v3.holdings.badge.noPriceSpoken') : null,
        // And the lookalike louder than either, because a screen reader is
        // where the attack is strongest: `UЅDС` and `USDC` are not merely
        // similar when spoken, they are IDENTICAL. The badge is the only
        // thing that distinguishes them, so it cannot be visual-only.
        item.token.lookalikeOf
          ? t('v3.holdings.badge.lookalikeSpoken', {
              symbol: item.token.symbol,
              impersonates: item.token.lookalikeOf,
            })
          : null,
        resolveNumeric(item.value, { currency }).text,
      ]),
    }),
    columns: [
      {
        key: 'symbol',
        headerKey: 'ui.dataView.holdings.col.holding',
        sortable: true,
        width: 'w-[22%]',
        render: (item) => (
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-label">{item.token.symbol}</span>
              {item.token.lookalikeOf ? (
                <LookalikeBadge
                  symbol={item.token.symbol}
                  impersonates={item.token.lookalikeOf}
                  t={t}
                />
              ) : null}
              {item.isActive ? null : (
                <Badge variant="secondary" className="shrink-0">
                  {t('v3.holdings.peek.inactive')}
                </Badge>
              )}
              {item.unpriceable ? <UnpriceableBadge t={t} /> : null}
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
        //
        // The lookalike rows are the one exception, and they have to be. A
        // spreadsheet renders `UЅDС` and `USDC` identically, sorts them apart
        // for no visible reason, and silently fails to match them against
        // anything — so exporting the bare symbol carries the impersonation
        // out of the app intact and into a file with no tooltip to correct it.
        // These rows cost the column's purity; every other row keeps it.
        exportValue: (item) =>
          exportText(
            item.token.lookalikeOf
              ? t('v3.holdings.badge.lookalikeExportCell', {
                  symbol: item.token.symbol,
                  impersonates: item.token.lookalikeOf,
                })
              : item.token.symbol
          ),
      },
      {
        key: 'account',
        headerKey: 'ui.dataView.holdings.col.account',
        width: 'w-[16%]',
        render: (item) => <span className="truncate">{item.account.name}</span>,
      },
      {
        key: 'institution',
        headerKey: 'ui.dataView.holdings.col.institution',
        width: 'w-[16%]',
        render: (item) => <InstitutionCell holding={item} />,
        exportValue: (item) => exportText(item.institution.name),
      },
      {
        key: 'amount',
        headerKey: 'ui.dataView.holdings.col.amount',
        sortable: true,
        numeric: true,
        render: (item) => holdingAmount(item, t),
        // The raw unit count, not the rounded display figure: a balance is the
        // one column where the digits the row hides are the ones an accountant
        // wants.
        exportValue: (item) => exportNumber(item.amount, amountDecimals(item.amount)),
      },
      {
        key: 'price',
        headerKey: 'ui.dataView.holdings.col.price',
        sortable: true,
        numeric: true,
        render: (item) => <Numeric value={holdingPrice(item)} currency={currency} />,
        exportValue: (item) => exportMoney(holdingPrice(item), currency),
      },
      {
        key: 'value',
        headerKey: 'ui.dataView.holdings.col.value',
        sortable: true,
        numeric: true,
        render: (item) => <Numeric value={item.value} currency={currency} />,
        exportValue: (item) => exportMoney(item.value, currency),
        exportTotal: true,
      },
      {
        key: 'pnl',
        headerKey: 'ui.dataView.holdings.col.gainLoss',
        sortable: true,
        numeric: true,
        width: 'w-[12%]',
        render: (item) => holdingRowDelta(item) ?? <span className="text-muted-foreground">—</span>,
        exportValue: (item) => exportPercent(holdingGainLoss(item)?.percent),
      },
    ],
    empty: {
      icon: PieChart,
      titleKey: 'ui.dataView.holdings.empty.title',
      descriptionKey: 'ui.dataView.holdings.empty.description',
      // The capture sheet, not a link: this description names three ways in
      // and the sheet is the thing that lists all of them. Capture stopped
      // being a route in V3-14 — it opens over whatever you are reading, so
      // an empty holdings list is still behind it when the sheet is dismissed.
      action: <Button onClick={onAddData}>{t('v3.holdings.empty.action')}</Button>,
    },
    peek: {
      basePath: V3_ROUTES.holdings,
      render: (item) => holdingPeekSpec(item, peek),
    },
    renderBulkActions: (selectedIds, clearSelection) => (
      <>
        <Button variant="outline" onClick={() => onAssignGroups([...selectedIds], clearSelection)}>
          <Tags className="mr-2 size-4" aria-hidden="true" />
          {t('v3.holdings.bulk.assignGroups')}
        </Button>
        <BulkDeleteAction
          count={selectedIds.size}
          nounKey="ui.dataView.noun.holdings"
          isPending={isBulkDeleting}
          // One pluralised key, not a frame with pronouns interpolated into
          // it: the sentence agrees in three places — "is/are", "it/them" —
          // and a language that marks case would otherwise be handed an
          // English pronoun table to fill in (SC-201).
          consequence={t('v3.holdings.bulk.deleteConsequence', {
            count: selectedIds.size,
            symbols: selectedSymbols(holdings, selectedIds),
          })}
          onConfirm={() => onBulkDelete([...selectedIds], clearSelection)}
        />
      </>
    ),
  };
}
