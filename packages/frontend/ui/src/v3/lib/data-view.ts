import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { uiT } from '../../i18n';
import type {
  DataViewConfigBase,
  FilterDefBase,
  GroupByDefBase,
  SortDefBase,
} from '../hooks/useDataView';
import type { ExportCell } from './export/cell';
import type { PeekConfig } from './peek';

/**
 * The v3 list surface's config shape, and the pure part of its copy.
 *
 * `useDataView` itself is imported from v2 unchanged — search, filter, sort,
 * group-by and bulk-select are the right model and V3-10 replaces the
 * presentation, not the state machine. What is new here is the shape of what a
 * surface must declare, and two of those requirements are the ticket:
 *
 * - `renderRow` returns the three zones of a `<DataRow>` rather than a free
 *   `ReactNode`. v2's `renderCard` let `HoldingCard` grow to fifteen data
 *   points; a signature with three slots cannot.
 * - `empty` is **required**. v2 fell back to "No items found" with an inbox
 *   icon, which is the shape of an empty state with none of the content, and
 *   the fallback is why eight surfaces shipped it. There is no fallback here.
 */

/** The three zones of a `<DataRow>`, as data. */
export interface RowSpec {
  label: ReactNode;
  sublabel?: ReactNode;
  /** Favicon or avatar. The selection box takes this slot when selecting. */
  leading?: ReactNode;
  value: ReactNode;
  delta?: ReactNode;
  /** Required when `label` is not a plain string, so the row's tap target
   *  still announces what it opens. */
  ariaLabel?: string;
}

/**
 * v3's list definitions — the same shapes v2 uses, with a KEY where v2 has an
 * English word (SC-262).
 *
 * A fork rather than a widened union, and rather than an edit to v2's. A union
 * (`label: string | { key: string }`) compiles at every one of the 279 call
 * sites, so a surface can keep its English string forever and nobody finds out
 * — the same trap `nounKey?: string` would have been in SC-257, at fifteen
 * times the scale. Renaming the field makes the compiler produce the work list.
 *
 * v2 is untouched and keeps `FilterDef`/`SortDef`/`GroupByDef`. The hook that
 * consumes both now declares only what it actually reads (`FilterDefBase` and
 * friends), which is why neither dialect constrains the other.
 */
/**
 * A key the v3 kit resolves — and the reason it is a TYPE rather than a
 * convention (SC-266).
 *
 * These keys are resolved against `@scani/ui`'s own i18next instance, which
 * receives only the `ui.` half of a host's bundle. Two things then go wrong
 * silently, and both are now build errors instead:
 *
 *   const k: UiTranslationKey = 'v3.holdings.filter.type';  // wrong namespace
 *   const k: UiTranslationKey = vendor.name;                // DATA as a key
 *
 * The second is what left `options[].label` as text in SC-262. i18next
 * resolves an unknown key to *itself*, so a vendor's name passed as a key
 * renders perfectly while the type claims it was translated, and a genuine
 * typo is indistinguishable from a vendor called `ui.dataView.x.y`. A `string`
 * is not assignable to `` `ui.${string}` ``, so that mistake cannot compile.
 *
 * It also subsumes `i18n-keys.test.ts`'s prefix rule into the compiler. That
 * test stays for the INDIRECT cases a type cannot see — a key held in a table
 * and handed to `t()` somewhere else.
 */
export type UiTranslationKey = `ui.${string}`;

/**
 * A filter option's name: TEXT when it is data, a KEY when it is copy.
 *
 * The two are genuinely different things rather than an old way and a new way,
 * which is why this union is not the trap SC-257 and SC-262 both refused. Most
 * options are data — an institution's name, a group's name, a cloud tier —
 * and there is nothing to translate in them. A minority are copy: "Active",
 * "Revoked", "Bill", "Income".
 *
 * The call site declares which, and the compiler holds it to that: `labelKey`
 * takes only a `ui.`-prefixed literal, so data cannot be smuggled through it.
 * The remaining mistake — copy left in `label` — is the SAFE one: it renders
 * the English it renders today, and `scripts/scan-v3-strings.ts` still counts
 * it, so it stays visible rather than becoming a lie.
 */
/**
 * Text OR a key, never both — and the `?: never` arms are what make that true.
 *
 * A plain `{label} | {labelKey}` union does NOT reject an object carrying both.
 * TypeScript's excess-property check against a union admits any property
 * declared in *any* member, so `{ value, label, labelKey }` compiled cleanly
 * and `filterOptionLabel` silently took the key branch — discarding the
 * `label`. Since `label` is where the DATA lives (a vendor's name, a group's
 * name), the failure mode was a real name vanishing in favour of copy.
 *
 * SC-266 shipped believing this was already exclusive; the `@ts-expect-error`
 * asserting it was never evaluated, because no test file in the repo was
 * type-checked (SC-280).
 */
export type V3FilterOption =
  | { value: string; label: string; labelKey?: never }
  | { value: string; labelKey: UiTranslationKey; label?: never };

/**
 * The option's name for display, whichever branch it took.
 *
 * Discriminates on the VALUE, not on `'labelKey' in option`. The `?: never`
 * arms above put an (optional, always-undefined) `labelKey` on the text arm
 * too, so the `in` check stopped narrowing — and at runtime it also mis-read
 * an explicit `labelKey: undefined` as the key branch.
 *
 * Resolves against this package's own instance rather than a caller's `t`
 * (SC-318). `labelKey` is `ui.${string}`, which spans BOTH bundles — the host's
 * forwarded `ui.dataView.*` and this package's own 133 keys — and only `uiT`
 * holds all of them. A caller's `t` from a bare `useTranslation` hook renders the
 * second group as its own key.
 */
export function filterOptionLabel(option: V3FilterOption): string {
  return option.labelKey !== undefined ? uiT(option.labelKey) : option.label;
}

export interface V3FilterDef extends FilterDefBase {
  labelKey: UiTranslationKey;
  /**
   * The OPTION labels stay text, and deliberately (SC-262).
   *
   * Most of them are data, not copy: an institution's name, a group's name, a
   * document's detected purpose, a cloud tier. `options: entityOptions(...)`
   * and `groups.map((g) => ({ value: g.id, label: g.name }))` cannot have a key
   * because there is nothing to translate — the name is the name.
   *
   * A minority genuinely are copy — "Active" / "Revoked", "Bill" / "Income" —
   * and those are still English after this change. Typing the field as a key
   * would have made the majority lie: i18next resolves an unknown key to
   * itself, so a name would render correctly while the type claimed it was
   * translated, and a real typo would be indistinguishable from a vendor
   * called `ui.dataView.x.y`. That needs a discriminator, which is a modelling
   * decision of its own rather than a rename.
   */
  options: V3FilterOption[];
}

export interface V3SortDef extends SortDefBase {
  labelKey: UiTranslationKey;
}

export interface V3GroupByDef extends GroupByDefBase {
  labelKey: UiTranslationKey;
}

export interface V3ColumnDef<T> {
  key: string;
  /** Rendered as the `<th>`, and read into `Sort by {{header}}`. */
  headerKey: UiTranslationKey;
  render: (item: T) => ReactNode;
  sortable?: boolean;
  /** Right-aligned and never wrapped — where a `<Numeric>` goes. */
  numeric?: boolean;
  /** A Tailwind width utility. Under `table-fixed` this is the column's share
   *  of the table; columns without one split what is left. */
  width?: string;
  /**
   * What this column *is*, for the export (SC-89) — as a figure, a date or a
   * string, rather than as the text `render` happens to produce.
   *
   * **Mandatory in practice for any column carrying a number.** `render`
   * returns a `<Numeric>`, and a React element's formatted output is not
   * reachable from its children — `lib/export/data-view.ts` recovers text from
   * plain children only, so a figure column without this exports blank rather
   * than exporting `"€1,234.56"` as a string. That is deliberate: a money
   * column that arrives in Excel as text is unsummable and looks fine, which is
   * the worst combination an export can have.
   *
   * A money cell may carry SC-60's base-currency companion, and where the
   * screen shows `£42.50 / ≈ €49.73` it must: the export writes both, and names
   * the converted column as converted.
   */
  exportValue?: (item: T) => ExportCell;
  /**
   * Whether this column's figures **add up** — the statement PDF prints a
   * summary total for it (SC-94).
   *
   * Declared rather than inferred, and **off by default**, because being money
   * is not the same as being additive. A holding's *value* sums to a portfolio;
   * the *price* beside it sums to nothing, and a column of daily net-worth
   * snapshots sums to a number that looks like wealth and is arithmetic on
   * itself. Both would be printed as `TOTAL` on a document going to a bank.
   *
   * The default is the safe mistake: forgetting a column costs a missing total
   * that someone will ask for, where guessing costs a wrong one that nobody
   * will check.
   */
  exportTotal?: boolean;
}

/** What a surface says when it has nothing to show *and nothing is filtered*.
 *  The action is not optional: an empty screen is an invitation to act. */
export interface EmptyStateSpec {
  icon: LucideIcon;
  titleKey: UiTranslationKey;
  descriptionKey?: UiTranslationKey;
  /**
   * Interpolation for both keys — `{ count: 90 }` for "Nothing due in the next
   * 90 days", which is the horizon the surface was built with rather than a
   * word. Without it an empty state that counts could not be keyed at all, and
   * `UpcomingFeed` is one.
   */
  values?: Record<string, string | number>;
  action: ReactNode;
}

export interface V3DataViewConfig<T>
  extends Omit<DataViewConfigBase<T>, 'defaultView' | 'filterDefs' | 'sortDefs' | 'groupByDefs'> {
  filterDefs?: V3FilterDef[];
  sortDefs?: V3SortDef[];
  groupByDefs?: V3GroupByDef[];
  /**
   * The list's noun, as a KEY into `@scani/ui`'s i18next instance (SC-257).
   *
   * It was `noun: 'holdings'` — an English word this package spliced into six
   * sentences it owns. Measured at 393px after SC-202's data-view chunk: the
   * Refine sheet read "Refine" translated beside "19 holdings · changes apply
   * as you make them" untranslatable, in one screenshot.
   *
   * **Four forms, one key**, resolved with i18next's context + plural:
   *
   *     t(nounKey, { count })                        -> "holding" / "holdings"
   *     t(nounKey, { count, context: 'counted' })    -> "1 holding" / "19 holdings"
   *
   * so `en.json` carries `X_one`, `X_other`, `X_counted_one`,
   * `X_counted_other`. One field rather than two because the pair must never
   * drift, and a single key whose four forms are checked by a test beats two
   * fields nothing binds together.
   *
   * The keys live in the HOST's locale file under `ui.` and reach this package
   * through `addUiLocale` — `apps/frontend/app/src/i18n` already forwards that
   * half of its bundle, and `frontend/cloud` registers its own with one call
   * and no i18next of its own. The alternative, a noun table inside this
   * package, would make adding a list to an app a change to the design system.
   */
  nounKey: UiTranslationKey;
  searchPlaceholderKey?: UiTranslationKey;
  /**
   * Search on the SERVER instead of over `data` (SC-244).
   *
   * Declare it on a surface fed by a paginated read, where `searchFn` narrows
   * whatever "Load more" happens to have fetched and reports the result as if
   * it had read the table. The debounced term arrives here; the surface puts it
   * in its query input and the reply *is* the filtered set.
   *
   * `searchFn` is then ignored rather than merely unnecessary — `V3DataView`
   * drops it, because two predicates over one term narrow the list twice and
   * the client's pass is the one that only sees a page.
   *
   * It also changes what an empty result MEANS, which is why the component
   * needs to know rather than the page: the server looked at every row, so
   * "No files match “x”" is a claim about the whole set. A client-side filter
   * over the same page cannot say that.
   */
  onSearch?: (term: string) => void;
  renderRow: (item: T) => RowSpec;
  /**
   * Names the row list's value zone on the phone surface, where there is no
   * table header to do it.
   *
   * Only for a surface whose value is not self-evident from the rows. On
   * `/vendors` it is not: the column reads €0.00 / €65.82 / €411.67 and the
   * summary directly above it carries **two** labelled totals ("Committed each
   * month" and "Paid in the last N months"), so an unheaded money column is a
   * figure the reader cannot attach to either of them (SC-69 3.3). The desktop
   * table has always had "Per month" in its `columns`; this is that header, at
   * the width where the table is not offered.
   *
   * A list whose rows are obviously the thing they are (a holding's value, a
   * document's size) leaves this unset rather than captioning the obvious.
   */
  valueHeaderKey?: UiTranslationKey;
  columns: V3ColumnDef<T>[];
  empty: EmptyStateSpec;
  /**
   * What the surface says *about* the rows below it, above the toolbar.
   *
   * It receives the **filtered** set rather than the whole one, which is the
   * only reason it belongs here instead of in the page: a total that ignores
   * the filter the user just applied is a wrong number on the screen, and the
   * page cannot compute the right one because the filtering lives in this
   * component's hook.
   *
   * Above the sticky toolbar, so it scrolls away — a summary is the answer to
   * "what am I looking at" on arrival, not a permanent header competing with
   * the rows for a phone's vertical space.
   */
  summary?: (items: T[]) => ReactNode;
  /** Tapping a row opens the peek sheet (V3-11) at a URL of its own. Declare
   *  this *or* `onRowClick` — a surface whose records have a page of their own
   *  navigates, one whose records are a handful of facts peeks. When both are
   *  set the peek wins, because a row cannot mean two things. */
  peek?: PeekConfig<T>;
  onRowClick?: (item: T) => void;
  /**
   * The URL `onRowClick` navigates to — the same destination, said in a way
   * the browser can act on (SC-118).
   *
   * A row that leads to a page was a `<tr>` with a click handler and no anchor
   * anywhere inside it, so Cmd+click navigated *this* tab: the app honoured
   * the "go there" half of the instruction and ignored the "without moving me"
   * half, costing the reader the scroll position they were trying to protect.
   * There was no link to copy or open from the context menu either.
   *
   * Set it wherever `onRowClick` navigates, and leave it unset on a peek list:
   * a sheet has no URL of its own that a second tab could be opened at.
   */
  rowHref?: (item: T) => string;
  /**
   * The bar over a non-empty selection.
   *
   * `deselect` is the third argument rather than a second `clearSelection`
   * because a bulk action can discover mid-confirm that some of the selected
   * rows cannot be written — the transfer queue refuses a linked row, or a
   * disposal onto the reader's own wallet (SC-382). Clearing everything there
   * throws away the reader's work; narrowing the selection for them, silently,
   * is the drop-rows-without-saying-so failure the confirmation exists to
   * prevent. So the action names the rows and offers the subtraction.
   */
  renderBulkActions?: (
    selectedIds: Set<string>,
    clearSelection: () => void,
    deselect: (ids: readonly string[]) => void
  ) => ReactNode;
}

/**
 * The name a tappable row exposes — the identity zones and the figure, in the
 * order they are read on screen.
 *
 * A row's accessible name has to do the job its *layout* does for a sighted
 * reader: tell it apart from the row above it. `/holdings` named two positions
 * worth €73,782 and €53,898 identically (`BTC, Bitcoin`), and home's Top
 * holdings named two different rows `BTC — open` (SC-71 7.2) — visually
 * disambiguated by account and value, and not disambiguated at all to
 * VoiceOver. Commas rather than a dash so each part gets a pause, and no
 * trailing verb: the row is a `<button>`, so the role already says it opens.
 *
 * Empty parts are dropped rather than rendered as gaps, because a row whose
 * value is unpriceable should not announce a name with a hole in it.
 */
export function rowName(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part?.trim())).join(', ');
}

export interface ActiveFilter {
  key: string;
  /**
   * Both halves RESOLVED, not keys (SC-266).
   *
   * The label is a key when the surface declared a def and the raw filter key
   * when a persisted filter names one that no longer exists — so the field
   * could only be typed `UiTranslationKey` by lying about the fallback, which
   * is the mistake this ticket exists to stop. `resolveActiveFilters` resolves
   * both against `uiT` and hands on text.
   */
  label: string;
  /** The chosen option's name — data or resolved copy. See `V3FilterOption`. */
  value: string;
}

/**
 * Resolves `{ institutionId: 'abc' }` into the names a person can read, in the
 * order the surface declared its filters rather than object-key order.
 */
export function resolveActiveFilters(
  filters: Record<string, string>,
  filterDefs: V3FilterDef[] | undefined
): ActiveFilter[] {
  const entries = Object.entries(filters).filter(([, value]) => value);
  if (!filterDefs) {
    return entries.map(([key, value]) => ({ key, label: key, value }));
  }

  const ordered: ActiveFilter[] = [];
  for (const def of filterDefs) {
    const value = filters[def.key];
    if (!value) continue;
    ordered.push({
      key: def.key,
      label: uiT(def.labelKey),
      value: (() => {
        const option = def.options.find((o) => o.value === value);
        return option ? filterOptionLabel(option) : value;
      })(),
    });
  }
  // A filter with no matching def still has to be removable, or a stale
  // persisted key would be an un-clearable empty list.
  for (const [key, value] of entries) {
    if (!ordered.some((f) => f.key === key)) ordered.push({ key, label: key, value });
  }
  return ordered;
}

/**
 * "1 holding" / "12 holdings", from the surface's own noun key.
 *
 * `singularNoun` is GONE with it, and deliberately (SC-257). It picked the
 * singular by stripping a trailing `s`, with a `nounSingular` escape hatch for
 * the words that would not — two mechanisms for one job, and only i18next's
 * handles a language with more than two forms. Measured on the real resolver:
 *
 *     ru, count 1 -> "1 актив"   3 -> "3 актива"   7 -> "7 активов"
 *
 * No suffix rule produces the third form, and a fallback that tried would give
 * a wrong word wherever the key was incomplete rather than a visible miss.
 *
 * The nouns live in the HOST's locale file and reach this instance through
 * `addUiLocale` at boot, so `uiT` resolves them with nothing threaded through
 * (SC-318) — measured, not assumed: `ui.dataView.noun.holdings` renders
 * "12 holdings" / "1 holding" against `uiT` with the app's bundle forwarded.
 */
export function countLabel(nounKey: string, count: number): string {
  return uiT(nounKey, { count, context: 'counted' });
}

/**
 * "BTC, ETH and AAPL" — the selection, said in the reader's own words.
 *
 * A bulk-delete confirmation that only says "3 holdings" asks the reader to
 * trust the count. Naming them lets them check, which is the entire point of a
 * confirm: SC-63's whole complaint is that the destructive path never gave
 * anyone a chance to notice the wrong row was ticked.
 *
 * Capped, and the tail folded into "and N more", because past a few names the
 * sentence stops being checkable anyway and starts wrapping over the buttons
 * on a 390px screen.
 */
export function nameList(names: readonly string[], max = 3): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] as string;
  if (names.length <= max) {
    return uiT('ui.dataView.nameList.all', {
      head: names.slice(0, -1).join(', '),
      last: names[names.length - 1],
    });
  }
  return uiT('ui.dataView.nameList.more', {
    count: names.length - max,
    head: names.slice(0, max).join(', '),
  });
}

/**
 * What a list surface draws where the rows would go — one value, enumerated
 * (SC-244).
 *
 * These were four booleans read in three places, and the ticket is what happens
 * when two of the cases below collapse into one: `no-match` over a page is a
 * sentence about rows nobody looked at. Naming them makes the distinction
 * something a test can hold, and something the next case has to be added to
 * rather than folded into.
 */
export type DataViewSurface =
  | 'error'
  /** Nothing at all — the onboarding screen, a claim about the account. */
  | 'empty'
  /** Narrowed to nothing over the WHOLE set. */
  | 'no-match'
  /** Narrowed to nothing over the rows fetched so far. A different sentence. */
  | 'no-match-loaded'
  /** Rows, a skeleton, or the first frame of a wait — `LoadingRamp` decides. */
  | 'rows';

export interface DataViewSurfaceInput {
  isLoading: boolean;
  isError: boolean;
  /** Rows in hand — which over a paginated read is the LOADED count. */
  totalCount: number;
  /** Rows left after the local narrowing. */
  filteredCount: number;
  /** More rows exist on the server than are in hand. */
  partial: boolean;
  searchTerm: string;
  /** The search ran on the server, over every row. */
  searchIsRemote: boolean;
  activeFilterCount: number;
}

export interface DataViewSurfaceState {
  surface: DataViewSurface;
  /**
   * The account holds none of these — so the toolbar is suppressed, because a
   * search box over an empty surface is a control that cannot do anything.
   *
   * Deliberately NOT `totalCount === 0`. A remote search that found nothing
   * returns an empty page, and reading that as an empty account renders "No
   * files yet — upload your first invoice" at someone with four hundred.
   */
  hasNothingAtAll: boolean;
}

export function resolveDataViewSurface(input: DataViewSurfaceInput): DataViewSurfaceState {
  const searchedRemotely = input.searchIsRemote && input.searchTerm.length > 0;
  const hasNothingAtAll = input.totalCount === 0 && !input.partial && !searchedRemotely;

  // A failed refetch behind a list already on screen leaves the list standing:
  // the data is stale, not gone. The error only takes the surface when there is
  // nothing else to put there.
  if (input.isError && hasNothingAtAll) return { surface: 'error', hasNothingAtAll };
  // Nothing settled means "no answer yet", not "you own none of these".
  if (input.isLoading || input.filteredCount > 0) return { surface: 'rows', hasNothingAtAll };
  if (hasNothingAtAll) return { surface: 'empty', hasNothingAtAll };

  // The narrowing that only ever saw the fetched rows. A remote search is not
  // one of those: the server read every row, so its empty answer is about the
  // whole set even on page one.
  const narrowedLocally =
    input.activeFilterCount > 0 || (input.searchTerm.length > 0 && !input.searchIsRemote);
  return {
    surface: input.partial && narrowedLocally ? 'no-match-loaded' : 'no-match',
    hasNothingAtAll,
  };
}

export interface FilteredEmptyCopy {
  title: string;
  description?: string;
}

/**
 * The *filtered*-to-empty screen, which is a different screen from the empty
 * one and wants a different action — §7 of the design brief. It names the term
 * that matched nothing, because "No results" does not tell you which of the
 * four things you narrowed by is the one to undo.
 *
 * **`loadedCount` is what stops this sentence being a lie** (SC-244). Pass a
 * number when the narrowing ran over a *page* of a larger set — a client-side
 * filter above a `useInfiniteQuery` — and the copy stops claiming to have
 * looked at rows it never fetched. `null` is the positive claim that the
 * narrowing saw everything there is.
 *
 * Typographic quotes: this is prose, and a straight quote inside a sentence set
 * in Plex Sans reads as code.
 *
 * The frame — `ui.dataView.empty.*` — is THIS package's copy and lives nowhere
 * else, so a caller's `t` from a bare `useTranslation` hook renders every
 * sentence here as a raw key while the noun inside it resolves fine (SC-318).
 * That is the one of the four where the parameter was load-bearing in the
 * wrong direction — measured, before this change:
 *
 *     describeFilteredEmpty(appT, 'ui.dataView.noun.holdings', 'sol', [])
 *       -> "ui.dataView.empty.noMatchSearch"
 */
export function describeFilteredEmpty(
  nounKey: string,
  searchTerm: string,
  activeFilters: ActiveFilter[],
  loadedCount: number | null = null
): FilteredEmptyCopy {
  // The plural form, because the sentence is about a set. It arrives already
  // translated, so a translator sees both halves as keys — which is the whole
  // change. What it does NOT fix is grammatical case: a language that would
  // decline "holdings" here receives the nominative and has to reword the
  // frame around it. That is a translator's problem to solve, where an English
  // word inside a French sentence was nobody's.
  const noun = uiT(nounKey, { count: 2 });
  const partial = loadedCount !== null;
  // The narrowed-a-page title deliberately drops the search term. "No transfers
  // match “Revolut”" is a claim about the user's transfers; over 25 of 579 rows
  // the honest claim is about the 25, and the term is in the search box two
  // inches above it either way.
  const title = partial
    ? uiT('ui.dataView.empty.noMatchLoaded')
    : searchTerm
      ? uiT('ui.dataView.empty.noMatchSearch', { noun, search: searchTerm })
      : uiT('ui.dataView.empty.noMatchFilters', { noun });

  const lines = [
    ...(partial
      ? [uiT('ui.dataView.empty.loadedOnly', { counted: countLabel(nounKey, loadedCount) })]
      : []),
    ...(activeFilters.length > 0
      ? [
          uiT('ui.dataView.empty.filteredBy', {
            list: activeFilters.map((f) => `${f.label}: ${f.value}`).join(', '),
          }),
        ]
      : []),
  ];

  return lines.length > 0 ? { title, description: lines.join(' ') } : { title };
}
