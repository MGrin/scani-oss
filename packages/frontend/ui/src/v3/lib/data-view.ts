import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { DataViewConfig, FilterDef } from '../hooks/useDataView';
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

export interface V3ColumnDef<T> {
  key: string;
  header: string;
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
  title: string;
  description?: string;
  action: ReactNode;
}

export interface V3DataViewConfig<T> extends Omit<DataViewConfig<T>, 'defaultView'> {
  /** Lowercase plural — "holdings", "payments". Reads as "No holdings match
   *  “sol”", so it is the noun and never a sentence. */
  noun: string;
  /** Only when dropping the trailing `s` gets it wrong. */
  nounSingular?: string;
  searchPlaceholder?: string;
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
  valueHeader?: string;
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
  renderBulkActions?: (selectedIds: Set<string>, clearSelection: () => void) => ReactNode;
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
  /** The filter's own name — "Institution". */
  label: string;
  /** The chosen option's name — "Kraken". Falls back to the raw value when a
   *  persisted filter names an option that no longer exists. */
  value: string;
}

/**
 * Resolves `{ institutionId: 'abc' }` into the names a person can read, in the
 * order the surface declared its filters rather than object-key order.
 */
export function resolveActiveFilters(
  filters: Record<string, string>,
  filterDefs: FilterDef[] | undefined
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
      label: def.label,
      value: def.options.find((o) => o.value === value)?.label ?? value,
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
 * "holding" from "holdings". The surfaces here all pluralise by suffix —
 * `nounSingular` exists for the one that will not.
 */
export function singularNoun(noun: string, nounSingular?: string): string {
  return nounSingular ?? noun.replace(/s$/, '');
}

/**
 * "1 holding" / "12 holdings". A count line that says "1 holdings" is the kind
 * of detail that reads as an unfinished interface.
 */
export function countLabel(count: number, noun: string, nounSingular?: string): string {
  return `${count} ${count === 1 ? singularNoun(noun, nounSingular) : noun}`;
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
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
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
 * Typographic quotes: this is prose, and a straight quote inside a sentence set
 * in Plex Sans reads as code.
 */
export function describeFilteredEmpty(
  noun: string,
  searchTerm: string,
  activeFilters: ActiveFilter[]
): FilteredEmptyCopy {
  const title = searchTerm ? `No ${noun} match “${searchTerm}”` : `No ${noun} match those filters`;

  if (activeFilters.length === 0) return { title };

  const list = activeFilters.map((f) => `${f.label}: ${f.value}`).join(', ');
  return { title, description: `Filtered by ${list}.` };
}
