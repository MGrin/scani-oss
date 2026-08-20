import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useOverflowTitle } from '../../../hooks/useOverflowTitle';
import { useUiTranslation } from '../../../i18n';
import { cn } from '../../../lib/cn';
import { Checkbox } from '../../../ui/checkbox';
import type { V3ColumnDef } from '../../lib/data-view';

export interface DataViewGroup<T> {
  /** `null` when the list is not grouped. */
  label: string | null;
  items: T[];
}

interface DataViewTableProps<T> {
  groups: DataViewGroup<T>[];
  columns: V3ColumnDef<T>[];
  getId: (item: T) => string;
  /**
   * What the row is *called*, for the selection checkbox's accessible name
   * (SC-112). Every row checkbox used to be named "Select row
   * b10d1812-8573-49e7-…": thirty-six characters of hex, read out in full, with
   * nothing in it that identifies the row — and these checkboxes are what bulk
   * delete acts on, so the confirm could say "Delete 2 holdings" correctly
   * while the reader had no way to know *which* two they had picked.
   *
   * Supplied by `V3DataView` from the same `RowSpec` the phone surface names
   * its rows with, so the two surfaces say the same thing.
   */
  rowLabel?: (item: T) => string;
  /**
   * Where the row *goes*, for rows that open a page rather than a peek
   * (SC-118). Given one, the row's identity cell becomes a real link, which is
   * what restores Cmd/middle-click, "Open link in new tab" and the browser's
   * own href preview — none of which a click handler can offer.
   *
   * Peek lists leave this unset: their rows open a sheet on this page, there
   * is no URL to hand the browser, and a button is the right element.
   */
  rowHref?: (item: T) => string;
  selectable: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  isAllSelected: boolean;
  sortField: string;
  sortDirection: 'asc' | 'desc';
  onSetSort: (field: string) => void;
  onRowClick?: (item: T) => void;
}

/**
 * The desktop surface, offered only at `lg` and above.
 *
 * The whole point of this file is what it does *not* have: v2 wrapped the table
 * in `overflow-x-auto` and floored it at `min-w-[700px]`, so below 700px the
 * row label and the figure could not be on screen together — the spreadsheet
 * failure mode (research brief §2.2). Removing the scroller alone would only
 * move the problem, because an auto-layout table still overflows its container
 * when the content is wider than the box.
 *
 * `table-fixed` is what makes it structural. Column widths come from the header
 * row and the content adapts to them rather than the other way round, so the
 * table is exactly `w-full` at every width and `truncate` on an identity cell
 * actually truncates. Numeric columns are `whitespace-nowrap` and are never the
 * ones that give way — a truncated figure is worse than no figure. A numeric
 * column whose figures could outgrow an equal share should declare a `width`;
 * that is the one case this layout cannot absorb on its own.
 *
 * The markup is written out rather than taken from `@scani/ui`'s `Table`,
 * which wraps every table in `<div class="relative w-full overflow-auto">` —
 * the same scroller, one level up, and not removable from a call site. That
 * primitive is also on v2's type scale (`text-sm`) and v2's row hover
 * (`bg-muted/50`); v3 sets its own from the tokens. v2 keeps the primitive
 * unchanged.
 *
 * Grouping is a `<tbody>` per group inside **one** table, not one table per
 * group. A table per group repeats the header five times for five
 * institutions, and — worse — each table solves its own column widths, so the
 * figures stop landing in the same columns exactly when the user asked to
 * compare groups. One table means one header and one grid.
 */

function SortIcon({
  field,
  sortField,
  sortDirection,
}: {
  field: string;
  sortField: string;
  sortDirection: 'asc' | 'desc';
}) {
  if (field !== sortField) {
    return (
      <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    );
  }
  return sortDirection === 'asc' ? (
    <ArrowUp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
  ) : (
    <ArrowDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
  );
}

/**
 * A body cell that offers its full text on hover once the column has cut it
 * short — see `useOverflowTitle`. Its own component because the measurement is
 * per-cell and a hook cannot be called from inside a `map`.
 *
 * Only where the cell actually clips. A numeric column is `whitespace-nowrap`
 * with nothing hiding the overflow — the figure is fully readable while
 * `scrollWidth` still exceeds `clientWidth`, so measuring one would put a
 * tooltip on a number nobody is missing any of.
 */
function BodyCell({
  className,
  truncates,
  children,
}: {
  className?: string;
  truncates: boolean;
  children: ReactNode;
}) {
  const ref = useOverflowTitle<HTMLTableCellElement>();
  return (
    <td ref={truncates ? ref : undefined} className={className}>
      {children}
    </td>
  );
}

/** Whether the browser has been told to open this somewhere other than here.
 *  A modified click is an instruction with two halves, and honouring only the
 *  "go there" half is what SC-118 is about. */
function isModifiedClick(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

export function DataViewTable<T>({
  groups,
  columns,
  getId,
  rowLabel,
  rowHref,
  selectable,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
  isAllSelected,
  sortField,
  sortDirection,
  onSetSort,
  onRowClick,
}: DataViewTableProps<T>) {
  const { t } = useUiTranslation();
  const hasSelection = selectedIds.size > 0;

  return (
    // `text-label` (14px), not `text-body` (16px). The other half of SC-71
    // 8.1: this table is only ever shown at `lg` and up, where the reader has
    // a pointer and a tall window, and 16px cells inside 56px rows fitted
    // about sixteen rows on a 900px screen — a phone's density on a desktop's
    // real estate. 14px is the size a dense list is read at everywhere else in
    // the app; the *figures* keep their own treatment through `<Numeric>`.
    // `scroll-mt` on the rows for the reason `DataRowList` carries it: a row
    // the browser scrolls to must not land under the sticky toolbar (SC-71 8.4).
    <table className="w-full table-fixed border-collapse text-label [&_tr]:scroll-mt-[var(--v3-list-sticky,0px)]">
      <thead>
        <tr className="border-b border-border">
          {selectable && (
            <th className="w-12 px-3 py-2 text-left align-middle">
              <Checkbox
                checked={isAllSelected}
                onCheckedChange={() => (hasSelection ? onClearSelection() : onSelectAll())}
                aria-label={
                  hasSelection
                    ? t('ui.dataView.table.clearSelection')
                    : t('ui.dataView.table.selectAll')
                }
              />
            </th>
          )}
          {columns.map((col) => (
            <th
              key={col.key}
              scope="col"
              className={cn(
                'px-3 py-2 align-middle font-medium text-muted-foreground',
                col.width,
                col.numeric ? 'text-right' : 'text-left'
              )}
            >
              {col.sortable ? (
                // A button rather than a click handler on the cell: a sort
                // control has to be reachable by keyboard and has to announce
                // itself, and `<th onClick>` is neither.
                <button
                  type="button"
                  onClick={() => onSetSort(col.key)}
                  aria-label={t('ui.dataView.table.sortBy', { header: t(col.headerKey) })}
                  className={cn(
                    'inline-flex items-center gap-1.5 text-label',
                    'transition-colors duration-fast ease-emphasized hover:text-foreground',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    col.numeric && 'flex-row-reverse'
                  )}
                >
                  <span className="truncate">{t(col.headerKey)}</span>
                  <SortIcon field={col.key} sortField={sortField} sortDirection={sortDirection} />
                </button>
              ) : (
                <span className="block truncate text-label">{t(col.headerKey)}</span>
              )}
            </th>
          ))}
        </tr>
      </thead>
      {groups.map((group) => (
        <tbody key={group.label ?? '_all'}>
          {group.label === null ? null : (
            <tr>
              <th
                scope="colgroup"
                colSpan={columns.length + (selectable ? 1 : 0)}
                className="border-b border-border px-3 pb-1 pt-5 text-left text-caption font-medium uppercase tracking-wide text-muted-foreground"
              >
                {/* Beside the label, never pushed to the far edge — see
                    `DataViewGroupHeading`, where SC-71 8.2 is explained. A
                    `colgroup` header spans the whole table, so this is the
                    width at which the separation was worst. */}
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 truncate">{group.label}</span>
                  <span className="shrink-0 tabular-nums">
                    <span aria-hidden="true">· </span>
                    {group.items.length}
                    <span className="sr-only">
                      {' '}
                      {t('ui.dataView.table.rowCount', { count: group.items.length })}
                    </span>
                  </span>
                </span>
              </th>
            </tr>
          )}
          {group.items.map((item) => {
            const id = getId(item);
            const isSelected = selectedIds.has(id);
            const href = rowHref?.(item);
            return (
              <tr
                key={id}
                // A height on a `td` is a minimum under table layout, so this
                // floors every single-line row at the same height while a cell
                // with two lines of content still grows. Carried over from v2,
                // where it was the fix for the same list component looking like
                // two different ones across pages.
                //
                // 44px rather than v2's 56px (SC-71 8.1). 56px is a *touch*
                // row height, and it was being spent at the one width where
                // nothing on screen is a touch target — about a third of the
                // rows a 900px window can hold, for padding.
                className={cn(
                  'border-b border-border transition-colors duration-fast ease-emphasized',
                  '[&>td]:h-11',
                  isSelected && 'bg-surface-hover',
                  onRowClick &&
                    'cursor-pointer hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
                )}
                // A focusable row with a key handler, rather than a bare `onClick`
                // as v2 had: the pointer path and the keyboard path open the same
                // record. No `role="button"` — that would replace the row's table
                // semantics, and a screen reader needs the cell structure more
                // than it needs to be told the row is pressable.
                tabIndex={onRowClick ? 0 : undefined}
                onClick={
                  onRowClick
                    ? (event) => {
                        // The link in the identity cell is the browser's to
                        // handle — it already knows what Cmd+click on an
                        // anchor means, and handling it here as well would
                        // navigate this tab *and* open a new one.
                        if ((event.target as HTMLElement).closest('a')) return;
                        // Anywhere else on the row, a modified click means the
                        // same thing it means on the link. Doing nothing would
                        // be better than moving the reader (SC-118); opening
                        // the tab they asked for is better still.
                        if (isModifiedClick(event)) {
                          if (href) window.open(href, '_blank', 'noopener,noreferrer');
                          return;
                        }
                        onRowClick(item);
                      }
                    : undefined
                }
                // Middle-click does not fire `click` at all, so the row would
                // otherwise answer the one gesture whose entire meaning is
                // "open this without moving me" by doing nothing.
                onAuxClick={
                  href
                    ? (event) => {
                        if (event.button !== 1) return;
                        if ((event.target as HTMLElement).closest('a')) return;
                        event.preventDefault();
                        window.open(href, '_blank', 'noopener,noreferrer');
                      }
                    : undefined
                }
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        if (event.target !== event.currentTarget) return;
                        event.preventDefault();
                        onRowClick(item);
                      }
                    : undefined
                }
              >
                {selectable && (
                  // The checkbox answers its own clicks. v2 made the whole cell a
                  // hit target because a 16px box is a hard tap — but this table
                  // is only ever shown at `lg` and up, where the pointer is
                  // precise and the extra handler is a second, keyboard-invisible
                  // way to do what the box already does.
                  <td className="px-3 align-middle">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => onToggleSelect(id)}
                      onClick={(e) => e.stopPropagation()}
                      // The row's own name, never its id (SC-112). The id is
                      // the fallback only because a name is worse than useless
                      // when it is absent, and every surface that can supply
                      // one does.
                      // The name is DATA — a holding's symbol, a vendor's
                      // name — so it interpolates rather than translating.
                      aria-label={t('ui.dataView.table.selectRow', {
                        name: rowLabel?.(item) || id,
                      })}
                    />
                  </td>
                )}
                {columns.map((col, index) => {
                  const content = col.render(item);
                  return (
                    <BodyCell
                      key={col.key}
                      truncates={!col.numeric}
                      className={cn(
                        'px-3 align-middle',
                        col.width,
                        col.numeric ? 'whitespace-nowrap text-right' : 'truncate'
                      )}
                    >
                      {/* The identity cell carries the link, so the row leads
                          somewhere the browser can see: Cmd/middle-click, the
                          context menu's "Open in new tab", the status-bar
                          preview. `tabIndex={-1}` because the row is already
                          one tab stop that opens the same record with Enter,
                          and two stops per row doubles the length of every
                          list for a keyboard. */}
                      {href && index === 0 ? (
                        <Link to={href} tabIndex={-1} className="block truncate">
                          {content}
                        </Link>
                      ) : (
                        content
                      )}
                    </BodyCell>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      ))}
    </table>
  );
}
