import { Download, Search, Sliders, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { englishNoun, useUiTranslation } from '../../../i18n';
import { cn } from '../../../lib/cn';
import { Badge } from '../../../ui/badge';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
// Aliased: `showError` is already a local in this component — the boolean
// that decides whether the error panel takes the surface.
import { showError as showErrorToast, showSuccess } from '../../../ui/use-toast';
import { useDataView } from '../../hooks/useDataView';
import { useDataViewUrlState } from '../../hooks/useDataViewUrlState';
import { useDelayedLoading } from '../../hooks/useDelayedLoading';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { usePeekRoute } from '../../hooks/usePeekRoute';
import { useSheetRoute } from '../../hooks/useSheetRoute';
import { useStickyOffset } from '../../hooks/useStickyOffset';
import {
  countLabel,
  resolveActiveFilters,
  resolveDataViewSurface,
  type V3DataViewConfig,
} from '../../lib/data-view';
import { readDataViewUrl } from '../../lib/data-view-url';
import {
  buildDataViewSheets,
  describeExportRefinement,
  exportAllScopeLabel,
  nodeText,
} from '../../lib/export/data-view';
import { describeDownload, downloadFile, exportFileName } from '../../lib/export/download';
import { toExportBlob } from '../../lib/export/format';
import { SETTLED_QUERY_STATE, type V3QueryState } from '../../lib/query-state';
import { exportSheet, refineSheet } from '../../lib/sheet';
import { LoadingRamp } from '../feedback/LoadingRamp';
import { QueryError } from '../feedback/QueryError';
import { PeekSheet } from '../PeekSheet';
import { DataViewEmpty, DataViewFilteredEmpty, LoadMoreButton } from './DataViewEmpty';
import { DataViewRows } from './DataViewRows';
import { DataViewSkeleton } from './DataViewSkeleton';
import { type DataViewGroup, DataViewTable } from './DataViewTable';
import { type ExportRequest, ExportSheet } from './ExportSheet';
import { RefineSheet } from './RefineSheet';

/**
 * The v3 list surface — `DataView`'s successor.
 *
 * The state machine is v2's `useDataView`, imported unchanged: search, filter,
 * sort, group-by and bulk-select are the right model and this ticket replaces
 * the presentation. What changes is everything below that:
 *
 * - **The table is not offered below `lg`.** `<DataRow>` list on a phone, table
 *   on a desktop, chosen by viewport rather than by a persisted user toggle. v2
 *   offered both at every width, so the default landed a 700px-wide
 *   horizontally-scrolling table on a 393px screen.
 * - **Refinement lives in a sheet**, not a permanently-mounted toolbar strip —
 *   and since SC-67 that sheet is a URL too (`?sheet=refine:<pageKey>`), so the
 *   back gesture closes it instead of navigating the list away underneath it.
 *   Since SC-71 the *result* of that sheet is a URL as well: the filters and the
 *   grouping are query parameters (`lib/data-view-url.ts`), so a narrowed list
 *   survives a reload, is shareable, and is undone by Back rather than by
 *   leaving the page.
 * - **Empty and filtered-empty are different screens** with different actions.
 * - **A row opens a peek sheet at a URL of its own** (V3-11), so the detail is
 *   linkable and the back gesture closes it.
 * - **Every list exports** (SC-89), from here rather than from each surface.
 *   Twelve surfaces share this component, and twelve export implementations
 *   would be twelve chances for the file's columns to drift from the table
 *   beside them. The file follows the visible table — same columns, same order,
 *   plus the group-by when one is applied — and the filtered set is what leaves
 *   by default. See `lib/export/`.
 *
 * That last one means this component reads the router unconditionally, whether
 * or not the surface declares a `peek` — a hook cannot be conditional, and the
 * alternative is every list surface repeating the same six lines of wiring. So
 * it must be rendered inside a `<Router>`; in a test that means `StaticRouter`
 * from `react-router-dom/server`.
 *
 * The `pageKey` is namespaced before it reaches `useDataView` because that hook
 * persists sort and view mode under it: an un-namespaced v3 holdings page would
 * share a localStorage record with v2's, and v3 writing a view mode it does not
 * even have a control for would flip v2's table to cards under the user.
 */

const SEARCH_DEBOUNCE_MS = 300;

/**
 * A group's heading. Exported because the group path is otherwise unreachable
 * from a test — `groupBy` is user state inside v2's hook with no config seed —
 * and a heading that carries a count is a claim worth checking.
 *
 * The count is the reason the heading is a heading rather than a label: "8" is
 * the thing the grouping was for. It is `tabular-nums` for the same reason
 * every figure in v3 is.
 *
 * It sits **beside the label**, not pushed to the far edge (SC-71 8.2). Pushed,
 * a `/payments` date group with one item put a bare `1` 1,200px from its date
 * at 1440 and 1,650px at 1920, where it reads as a stray character rather than
 * as that date's count — the separation is the whole defect, and no amount of
 * labelling fixes a figure the eye cannot pair with anything. The dot is the
 * pairing; the `sr-only` noun is what stops it being read as a bare number.
 */
export function DataViewGroupHeading({ label, count }: { label: string; count: number }) {
  const { t } = useUiTranslation();
  return (
    <h3 className="flex items-baseline gap-2 border-b border-border pb-1 pt-2 text-caption font-medium uppercase tracking-wide text-muted-foreground">
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 tabular-nums">
        <span aria-hidden="true">· </span>
        {count}
        <span className="sr-only"> {t('ui.dataView.itemCount', { count })}</span>
      </span>
    </h3>
  );
}

interface V3DataViewProps<T> {
  config: V3DataViewConfig<T>;
  getId: (item: T) => string;
  /**
   * The collapsed state of every query feeding `config.data` — see
   * `lib/query-state.ts`. It replaced a bare `isLoading` in V3-16 because the
   * error half was what every call site kept dropping: a surface that renders
   * `data ?? []` on a failed request tells the user they own nothing.
   *
   * Defaulted, because a list built from data already in hand (the gallery,
   * a locally derived list) has nothing to wait for and nothing to retry.
   */
  query?: V3QueryState;
}

export function V3DataView<T>({ config, getId, query = SETTLED_QUERY_STATE }: V3DataViewProps<T>) {
  const { t, i18n } = useUiTranslation();
  const language = i18n.language;
  const {
    nounKey,
    searchPlaceholderKey,
    renderRow,
    valueHeaderKey,
    columns,
    empty,
    peek,
    peekTrigger,
    onRowClick,
    rowHref,
    renderBulkActions,
    summary,
  } = config;

  const location = useLocation();
  // Seeded on the first render only, and *before* `useDataView` builds its
  // initial state: the sync effect below runs after paint, so without this a
  // reload of a filtered list would draw every row for one frame and then
  // remove most of them — which is the reported defect wearing a shorter
  // timescale. Later URL changes (Back, a shared link followed in place) go
  // through the effect, where a frame costs nothing.
  const seeded = useRef<Record<string, string> | null>(null);
  if (seeded.current === null) {
    seeded.current = readDataViewUrl(location.search, config.pageKey, config.filterDefs).filters;
  }

  const dv = useDataView(
    {
      ...config,
      pageKey: `v3:${config.pageKey}`,
      defaultFilters: { ...config.defaultFilters, ...seeded.current },
      // A surface that searches on the server must not also search on the
      // client: two predicates over one term is a list narrowed twice, and the
      // second pass is the one that only sees a page. Dropped here rather than
      // asked of the call site, so declaring both is harmless rather than
      // silently wrong.
      searchFn: config.onSearch ? undefined : config.searchFn,
    },
    getId
  );
  // Every control below writes the URL and nothing writes `dv` directly — see
  // `useDataViewUrlState` for why the sync is one-directional.
  const url = useDataViewUrlState(config.pageKey, config.filterDefs, dv);
  const loadingPhase = useDelayedLoading(query.isLoading);
  const isDesktop = useIsDesktop();
  const peekRoute = usePeekRoute(peek?.basePath);

  // Resolved against the surface's whole data set rather than the filtered
  // view: a shared link has to open the record even when the recipient's
  // persisted filters would have hidden it from the list behind the sheet.
  const peekItem =
    peekRoute.id === null
      ? null
      : (config.data.find((item) => getId(item) === peekRoute.id) ?? null);

  // The row opens the peek — unless the surface has moved the peek onto a
  // control of its own (SC-560), in which case the row leads wherever
  // `onRowClick` says and `openPeek` below is what opens the sheet.
  const openPeek = peek ? (item: T) => peekRoute.open(getId(item)) : undefined;
  const openRecord = peekTrigger ? onRowClick : (openPeek ?? onRowClick);

  // `?sheet=refine:<pageKey>` rather than component state (SC-67), for the
  // reason the peek is a URL: the back gesture has to close the sheet, not
  // navigate the list out from under it. Keyed by `pageKey` because a page can
  // mount two of these — `/v3/tokens` does — and a shared key would open both
  // sheets at once.
  const refine = useSheetRoute(refineSheet(config.pageKey));
  const exporting = useSheetRoute(exportSheet(config.pageKey));
  const [selecting, setSelecting] = useState(false);
  const [localSearch, setLocalSearch] = useState(dv.searchTerm);
  const stickyHeight = useStickyOffset();

  const { setSearchTerm } = dv;
  // Held in a ref so the debounce does not restart on every parent render: a
  // surface that passes an inline `onSearch` would otherwise clear and reset
  // the timer forever and the search would never fire.
  const onSearch = useRef(config.onSearch);
  useEffect(() => {
    onSearch.current = config.onSearch;
  });
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchTerm(localSearch);
      onSearch.current?.(localSearch);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [localSearch, setSearchTerm]);

  // The LANGUAGE is a dependency now that the filters are resolved rather than
  // carried as keys: without it the chips keep the language they were first
  // memoised in, so switching language would leave "Institution: Kraken" beside
  // a translated sheet. Biome caught this; it is not cosmetic.
  //
  // It is `i18n.language` rather than `t` because `resolveActiveFilters` no
  // longer takes one (SC-318). Naming the language is the honest dependency
  // either way — `t` was only ever a proxy for it, and the proxy is what let a
  // caller hand over an instance that could not resolve the keys.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `resolveActiveFilters` resolves against `uiT` internally, so the language it read is a real input Biome cannot see from the call site.
  const activeFilters = useMemo(
    () => resolveActiveFilters(dv.filters, config.filterDefs),
    [language, dv.filters, config.filterDefs]
  );

  /**
   * SC-244. Three facts this component used to collapse into one.
   *
   * - `partial` — `config.data` is a *page* of a larger set, so every count and
   *   every local narrowing below reasons about a fraction of the user's rows.
   *   It arrives on the query state rather than as a prop of its own precisely
   *   so a surface cannot forget to declare it; see `lib/query-state.ts`.
   * - `searchIsRemote` — the server ran the search over every row. That makes
   *   "No files match “x”" a true sentence about the whole set even on page
   *   one, which a *filter* over the same page is not.
   * - `narrowedLocally` — the narrowing that only ever saw the fetched rows.
   *   This is the one that has to say so.
   */
  const partial = query.more !== null;
  const searchIsRemote = config.onSearch !== undefined;

  /**
   * The export (SC-89). One implementation for every list surface, and the
   * three things it settles:
   *
   * - **The filtered set is what leaves by default.** The sheet offers the full
   *   one and names both counts; this function just honours the choice.
   * - **`All` is still sorted.** The reader's sort is a decision they made
   *   about how to read these records, and dropping it because they widened the
   *   scope would hand back a differently-ordered list than the one they were
   *   looking at a second ago. The filter goes; the ordering stays.
   * - **Failure is said out loud.** A silent no-op is the specific failure the
   *   ticket warns about on an installed iOS PWA, so both ends report: a toast
   *   on error, and a toast that distinguishes a saved file from one handed to
   *   the share sheet and then dismissed.
   */
  // "All 25" over a page of 579 is the screen's defect written to a file, where
  // it outlives the screen: someone opens that spreadsheet next month with no
  // way left to tell it was a quarter of their transfers (SC-244).
  const allScopeLabel = exportAllScopeLabel(nounKey, dv.totalCount, partial);
  // Only offered when the two differ: a list nothing has narrowed has one set,
  // and two identically-sized options is a question with one answer.
  const exportScopes =
    dv.filteredCount === dv.totalCount
      ? [
          {
            key: 'all',
            label: allScopeLabel,
            detail: partial ? t('ui.dataView.export.loadedOnly') : undefined,
          },
        ]
      : [
          {
            key: 'filtered',
            label: t('ui.dataView.export.scopeThese', {
              counted: countLabel(nounKey, dv.filteredCount),
            }),
            detail:
              describeExportRefinement(
                activeFilters,
                dv.searchTerm,
                dv.sortField,
                dv.sortDirection,
                config.sortDefs
              )
                .map((detail) => `${detail.label}: ${detail.value}`)
                .join(' · ') || t('ui.dataView.export.onScreenNow'),
          },
          {
            key: 'all',
            label: allScopeLabel,
            detail: partial
              ? t('ui.dataView.export.loadedOnly')
              : t('ui.dataView.export.ignoresFilters'),
          },
        ];

  const runExport = async ({ scope, format, separator, hideAmounts }: ExportRequest) => {
    const filtered = scope === 'filtered';
    const items = filtered
      ? dv.filteredData
      : config.sortFn && dv.sortField
        ? [...config.data].sort(
            (a, b) => config.sortFn?.(a, b, dv.sortField, dv.sortDirection) ?? 0
          )
        : config.data;

    if (items.length === 0) {
      // Belt as well as braces: the button is already disabled for this scope,
      // and a file that is only a header line is not an export — it is a
      // success message attached to nothing, which is exactly what someone
      // discovers a week later on a phone with no way to tell why.
      showSuccess(
        filtered ? t('ui.dataView.export.nothingFiltered') : t('ui.dataView.export.nothingAtAll'),
        t('ui.dataView.export.nothingTitle')
      );
      return;
    }

    try {
      const workbook = buildDataViewSheets({
        config,
        items,
        groupBy: dv.groupBy,
        filtered,
        filteredCount: dv.filteredCount,
        totalCount: dv.totalCount,
        activeFilters: filtered ? activeFilters : [],
        searchTerm: filtered ? dv.searchTerm : '',
        sortField: dv.sortField,
        sortDirection: dv.sortDirection,
        generatedAt: new Date(),
        hideAmounts,
        partial,
      });
      const blob = await toExportBlob(workbook, format, separator);
      // The filename is an IDENTIFIER, not copy, so it is pinned to English
      // rather than following the interface. `exportFileName` slugifies to
      // `[a-z0-9-]`, so a Japanese noun would slug to empty and every export
      // would land as `scani-export-2026-08-15.csv` — one name for every list.
      // A file someone keeps, re-imports and lays beside last month's should
      // also not change its name because they changed language.
      const fileName = exportFileName(englishNoun(nounKey), format, { filtered });
      const result = await downloadFile(blob, fileName);
      if (result.completed) {
        const said = describeDownload(result, fileName, countLabel(nounKey, items.length));
        showSuccess(said.message, said.title);
      }
    } catch (error) {
      showErrorToast(
        error,
        t('ui.dataView.export.errorContext', { noun: t(nounKey, { count: 2 }) })
      );
    }
  };

  const selectable = Boolean(renderBulkActions);
  // Desktop keeps its checkbox column standing — there is room for it and a
  // pointer is precise. On a phone selection is a mode, so leaving it has to
  // also drop the selection, or an invisible one survives into the next action.
  const rowsSelecting = selectable && !isDesktop && selecting;
  const { clearSelection } = dv;
  const leaveSelectionMode = () => {
    setSelecting(false);
    clearSelection();
  };

  const isEmpty = dv.filteredData.length === 0;
  // One resolved value rather than four booleans read in three places — see
  // `resolveDataViewSurface`, which is where the two "nothing here" cases stop
  // being the same case.
  const { surface, hasNothingAtAll } = resolveDataViewSurface({
    isLoading: query.isLoading,
    isError: query.isError,
    totalCount: dv.totalCount,
    filteredCount: dv.filteredCount,
    partial,
    searchTerm: dv.searchTerm,
    searchIsRemote,
    activeFilterCount: activeFilters.length,
  });
  const showError = surface === 'error';

  // One shape for both surfaces. Ungrouped is one unlabelled group rather than
  // a separate branch, so the table below is always rendered exactly once and
  // never has to reconcile "grouped" and "not grouped" markup.
  const groups: DataViewGroup<T>[] = dv.groupedData
    ? Array.from(dv.groupedData.entries()).map(([label, items]) => ({ label, items }))
    : [{ label: null, items: dv.filteredData }];

  // One source for what a row is called, so the desktop checkbox and the phone
  // row cannot disagree about it (SC-112). `ariaLabel` first — a `RowSpec`
  // supplies it exactly when `label` is not plain text and would recover as
  // nothing.
  const nameOf = (item: T) => {
    const spec = renderRow(item);
    return spec.ariaLabel ?? nodeText(spec.label).replace(/\s+/g, ' ').trim();
  };

  /**
   * The peek's own control, once it is no longer the row's meaning.
   *
   * A `<button>` calling the same `peekRoute.open` the row used to call,
   * rather than a `<Link>` to `peekPath`: `open` is what captures the trigger
   * for `useReturnFocus` and what stamps `peekOpenState`, so a link would
   * leave the sheet closing by REPLACE — landing the reader on the list with
   * their history entry spent — and take the focus return with it.
   */
  const renderPeekTrigger =
    peekTrigger && openPeek
      ? (item: T) => {
          const Icon = peekTrigger.icon;
          return (
            <button
              type="button"
              onClick={(event) => {
                // The row behind this control is itself clickable on both
                // surfaces — a `<td>` inside a clickable `<tr>` on desktop, a
                // sibling of the row's own `<button>` on the phone list, where
                // it does not bubble. Stopping it here covers the desktop case
                // without either surface having to know about the other.
                event.stopPropagation();
                openPeek(item);
              }}
              aria-label={t(peekTrigger.labelKey, { name: nameOf(item) })}
              className={cn(
                'flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground',
                'transition-colors duration-fast ease-emphasized hover:bg-surface-hover hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
            </button>
          );
        }
      : undefined;

  const content = isDesktop ? (
    <DataViewTable
      groups={groups}
      columns={columns}
      getId={getId}
      rowLabel={nameOf}
      // A peek list has no page to open in a second tab, so its rows stay
      // buttons — see `rowHref` on the config. A surface that moved its peek
      // off the row (`peekTrigger`) is not one of those: its rows lead to a
      // real URL again.
      rowHref={peek && !peekTrigger ? undefined : rowHref}
      renderRowAction={renderPeekTrigger}
      selectable={selectable}
      selectedIds={dv.selectedIds}
      onToggleSelect={dv.toggleSelect}
      onSelectAll={dv.selectAll}
      onClearSelection={dv.clearSelection}
      isAllSelected={dv.isAllSelected}
      sortField={dv.sortField}
      sortDirection={dv.sortDirection}
      onSetSort={dv.setSort}
      onRowClick={openRecord}
    />
  ) : (
    groups.map((group, index) => (
      <section key={group.label ?? '_all'} className="flex flex-col gap-1">
        {group.label === null ? null : (
          <DataViewGroupHeading label={group.label} count={group.items.length} />
        )}
        {/* Once, over the first run of rows — it names the column, and a
            column does not change meaning between groups. */}
        {valueHeaderKey && index === 0 ? (
          <p className="px-4 text-right text-caption text-muted-foreground">{t(valueHeaderKey)}</p>
        ) : null}
        <DataViewRows
          data={group.items}
          getId={getId}
          renderRow={renderRow}
          onRowClick={openRecord}
          renderTrailing={rowsSelecting ? undefined : renderPeekTrigger}
          selecting={rowsSelecting}
          selectedIds={dv.selectedIds}
          onToggleSelect={dv.toggleSelect}
        />
      </section>
    ))
  );

  // Nothing to search and nothing to narrow. A search box over an empty
  // surface is a control that cannot do anything, sitting directly above the
  // sentence explaining there is nothing here — and it pushes the one button
  // that matters further down the screen.
  const showToolbar = !showError && (query.isLoading || !hasNothingAtAll);

  return (
    // `--v3-list-sticky` is the toolbar's measured height, published here so the
    // rows below can hold it clear (SC-71 8.4). Without it a row scrolled into
    // view — by Tab, by the browser restoring a position, by any
    // `scrollIntoView` — lands flush against the top of the scroller and under
    // the sticky search header, which covers its value zone and leaves an
    // orphan row reading `Solana · Binance Spot  +60.7%` with no figure.
    <div className="flex flex-col gap-3" ref={stickyHeight.rootRef}>
      {/* Suppressed while loading and while the surface has nothing at all:
          a summary of no rows is a figure of zero presented as information,
          directly above the sentence explaining there is nothing here. */}
      {summary && !query.isLoading && !hasNothingAtAll ? summary(dv.filteredData) : null}

      {/* z-10 is the sticky rung of the ladder in §6 of the design brief. The
          sheet this toolbar opens is at 100 and passes over it. */}
      {showToolbar ? (
        <div
          ref={stickyHeight.barRef}
          className="sticky top-0 z-10 flex flex-col gap-2 bg-background pb-2 pt-1"
        >
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                value={localSearch}
                onChange={(e) => setLocalSearch(e.target.value)}
                placeholder={
                  (searchPlaceholderKey ? t(searchPlaceholderKey) : undefined) ??
                  t('ui.dataView.toolbar.search', { noun: t(nounKey, { count: 2 }) })
                }
                aria-label={t('ui.dataView.toolbar.search', {
                  noun: t(nounKey, { count: 2 }),
                })}
                // `text-body` is 16px. The shared Input is `text-sm`, and iOS
                // zooms the page on focusing anything below 16px — a bug that
                // reads as "the app jumped" and never gets filed as one.
                className="pl-9 text-body"
              />
            </div>

            <Button
              variant="outline"
              onClick={refine.open}
              aria-label={t('ui.dataView.toolbar.refineAria')}
              className="shrink-0 gap-2"
            >
              <Sliders className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t('ui.dataView.toolbar.refine')}</span>
              {activeFilters.length > 0 ? (
                <Badge variant="secondary" className="tabular-nums">
                  {activeFilters.length}
                </Badge>
              ) : null}
            </Button>

            {selectable && !isDesktop ? (
              <Button
                variant="ghost"
                onClick={() => (selecting ? leaveSelectionMode() : setSelecting(true))}
                className="shrink-0"
              >
                {selecting ? t('ui.dataView.toolbar.done') : t('ui.dataView.toolbar.select')}
              </Button>
            ) : null}
          </div>

          {activeFilters.length > 0 ? (
            // `flex-wrap`, never `overflow-x-auto`: a chip pushed off the right
            // edge is a filter the user cannot see is applied.
            <div className="flex flex-wrap items-center gap-1.5">
              {activeFilters.map((filter) => (
                <button
                  key={filter.key}
                  type="button"
                  onClick={() => url.setFilter(filter.key, '')}
                  aria-label={t('ui.dataView.toolbar.removeFilter', {
                    label: filter.label,
                    value: filter.value,
                  })}
                  className={cn(
                    // `border-border-strong`, not `border-border`: since V3-23
                    // the plain token is the decorative hairline and owes no
                    // contrast floor, and this border is the only thing saying
                    // a chip is a control you can press to remove the filter.
                    'inline-flex max-w-full items-center gap-1 rounded-md border border-border-strong px-2 py-1',
                    'text-caption transition-colors duration-fast ease-emphasized hover:bg-surface-hover',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                  )}
                >
                  <span className="truncate">
                    <span className="text-muted-foreground">{filter.label}: </span>
                    {filter.value}
                  </span>
                  <X className="h-3 w-3 shrink-0" aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : null}

          {!query.isLoading ? (
            // Export sits on the count line rather than beside Refine, and it
            // is the count line that makes it legible: the control's label is
            // the sentence to its left, so `Export` next to `12 of 69 holdings`
            // says what it will write without a word of its own. The control
            // row was the obvious home and the wrong one — a fourth control
            // there took the search field below the width its own placeholder
            // needs at 390px, and search is the thing on this bar that is used
            // constantly.
            <div className="flex items-center justify-between gap-2">
              {/* "25 transfers" is `data.length`, and over a paginated read
                  that is the loaded count wearing the total's clothes — the
                  half of SC-244 the ticket called honest. It is the same
                  number either way; what changes is whether the sentence
                  claims it is all of them. */}
              {/* `filteredCount !== totalCount` rather than `hasActiveFilters`:
                  a REMOTE search narrows nothing locally, so the two counts are
                  always equal and the old condition rendered "1 of 1 file" —
                  an "of" with nothing on either side of it. */}
              <p className="min-w-0 truncate text-caption text-muted-foreground">
                {dv.filteredCount !== dv.totalCount
                  ? t(
                      partial
                        ? 'ui.dataView.toolbar.filteredOfLoaded'
                        : 'ui.dataView.toolbar.filteredOf',
                      {
                        shown: dv.filteredCount,
                        counted: countLabel(nounKey, dv.totalCount),
                      }
                    )
                  : partial
                    ? t('ui.dataView.toolbar.loadedSoFar', {
                        counted: countLabel(nounKey, dv.totalCount),
                      })
                    : countLabel(nounKey, dv.totalCount)}
              </p>
              <button
                type="button"
                onClick={exporting.open}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-caption',
                  'text-muted-foreground transition-colors duration-fast ease-emphasized',
                  'hover:text-foreground focus-visible:outline-none focus-visible:ring-2',
                  'focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'
                )}
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                {t('ui.dataView.toolbar.export')}
                <span className="sr-only"> {t(nounKey, { count: 2 })}</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {dv.selectedIds.size > 0 && renderBulkActions ? (
        // Inline banner rather than a floating bar. v2 learned this the hard
        // way: fixed-at-bottom covered the two or three rows the user was
        // reaching for on a short viewport.
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-1 p-3">
          <span className="shrink-0 text-label">
            {t('ui.dataView.toolbar.selected', {
              counted: countLabel(nounKey, dv.selectedIds.size),
            })}
          </span>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {renderBulkActions(dv.selectedIds, dv.clearSelection, dv.deselect)}
          </div>
        </div>
      ) : null}

      {showError ? (
        <QueryError error={query.error} subject={t(nounKey, { count: 2 })} onRetry={query.retry} />
      ) : null}

      {/* Nothing for 300ms, a rail to 1s, the skeleton after that, and a
          stalled notice once the wait stops being credible — §2.5's ramp,
          decided in `useDelayedLoading` and drawn here. */}
      <LoadingRamp
        phase={loadingPhase}
        skeleton={<DataViewSkeleton />}
        label={t(nounKey, { count: 2 })}
        onRetry={query.retry}
      />

      {surface === 'empty' ? <DataViewEmpty empty={empty} /> : null}

      {surface === 'no-match' || surface === 'no-match-loaded' ? (
        <DataViewFilteredEmpty
          nounKey={nounKey}
          searchTerm={dv.searchTerm}
          activeFilters={activeFilters}
          // Only when the narrowing itself was partial. A remote search that
          // came back empty looked at every row, and telling that reader to
          // "load more" would send them paging through a set the server has
          // already reported holds no match.
          loadedCount={surface === 'no-match-loaded' ? dv.totalCount : null}
          more={surface === 'no-match-loaded' ? query.more : null}
          onClearFilters={() => {
            setLocalSearch('');
            url.clearFilters();
          }}
        />
      ) : null}

      {!isEmpty ? content : null}

      {/* Under the rows rather than inside them: the button widens what this
          surface can reason about, it does not page through it. Rendered here
          rather than by each page (SC-244) so the count line, the empty screen
          and the export label all read from the same fact. */}
      {query.more && !isEmpty ? (
        <div className="flex justify-center">
          <LoadMoreButton more={query.more} />
        </div>
      ) : null}

      <RefineSheet
        open={refine.isOpen}
        onOpenChange={refine.setOpen}
        nounKey={nounKey}
        filters={dv.filters}
        filterDefs={config.filterDefs}
        onSetFilter={url.setFilter}
        sortField={dv.sortField}
        sortDirection={dv.sortDirection}
        sortDefs={config.sortDefs}
        onSetSort={dv.setSort}
        groupBy={dv.groupBy}
        groupByDefs={config.groupByDefs}
        onSetGroupBy={url.setGroupBy}
        hasActiveFilters={dv.hasActiveFilters}
        onClearFilters={() => {
          setLocalSearch('');
          url.clearFilters();
        }}
        filteredCount={dv.filteredCount}
      />

      <ExportSheet
        open={exporting.isOpen}
        onOpenChange={exporting.setOpen}
        subject={t(nounKey, { count: 2 })}
        scopes={exportScopes}
        actionLabel={(scope) =>
          t('ui.dataView.export.action', {
            counted: countLabel(nounKey, scope === 'filtered' ? dv.filteredCount : dv.totalCount),
          })
        }
        // SC-116: the confirm goes dead on the empty scope rather than
        // producing a header-only file and calling it a success. The other
        // scope stays live, because "All 19 holdings" is the way out.
        disabled={(scope) => (scope === 'filtered' ? dv.filteredCount === 0 : dv.totalCount === 0)}
        onExport={runExport}
      />

      {peek ? (
        <PeekSheet
          open={peekRoute.id !== null}
          // The sheet only ever asks to close — there is no trigger inside it
          // to ask for the opposite, and a peek is opened by navigating.
          onOpenChange={(next) => {
            if (!next) peekRoute.close();
          }}
          spec={peekItem ? peek.render(peekItem) : null}
          noun={t(nounKey, { count: 1 })}
          isLoading={query.isLoading}
        />
      ) : null}
    </div>
  );
}
