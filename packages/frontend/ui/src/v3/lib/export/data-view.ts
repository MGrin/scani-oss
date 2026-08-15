import { isValidElement, type ReactNode } from 'react';
import type { GroupByDef, SortDef } from '../../hooks/useDataView';
import {
  type ActiveFilter,
  countLabel,
  type V3ColumnDef,
  type V3DataViewConfig,
} from '../data-view';
import { type ExportCell, exportText } from './cell';
import type { ExportWorkbook } from './format';
import { buildSheet, type ExportField, type ExportProvenance } from './workbook';

/**
 * A list surface, as a file.
 *
 * Built once, here, for every `V3DataView` — twelve surfaces share this
 * component and a per-surface export would be twelve chances for the columns to
 * drift from the table beside them. The rule is that the file follows **the
 * visible table**: the same columns in the same order, plus the group-by when
 * one is applied, because a grouped list's headings are data the reader put
 * there and a flat export loses them.
 *
 * The group is a *column* rather than repeated heading rows. A spreadsheet
 * groups by filtering or pivoting on a column; heading rows interleaved with
 * data rows are a picture of a grouped list, not a grouped list.
 */

/**
 * The text a column's `render` puts on screen, when the surface has not said
 * what the cell *means*.
 *
 * A deliberate fallback rather than the mechanism: it walks React children and
 * collects strings, which works for a column rendering a name or a label and
 * returns nothing for one rendering `<Numeric>` or a badge — a component's
 * output is not in its children. That is the right failure. A figure recovered
 * as the string `"€1,234.56"` would land in the file as text and read as a
 * number, which is the exact defect this export exists to avoid; a column that
 * carries a figure declares `exportValue` and gets a real one.
 */
export function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(' ');
  if (isValidElement(node)) {
    const { children } = node.props as { children?: ReactNode };
    return nodeText(children);
  }
  return '';
}

function columnField<T>(column: V3ColumnDef<T>): ExportField<T> {
  return {
    header: column.header,
    total: column.exportTotal,
    value: column.exportValue
      ? column.exportValue
      : (item: T): ExportCell => exportText(nodeText(column.render(item)).replace(/\s+/g, ' ')),
  };
}

function groupField<T>(def: GroupByDef): ExportField<T> {
  const groupFn = def.fn || def.groupFn;
  return {
    header: def.label,
    value: (item: T) => exportText(groupFn ? groupFn(item) : ''),
  };
}

export interface DataViewExportInput<T> {
  config: V3DataViewConfig<T>;
  /** Already scoped and already sorted — the order in the file is the order on
   *  screen, because that order is a choice the reader made. */
  items: readonly T[];
  /** The applied group-by key, or `''`. */
  groupBy: string;
  filtered: boolean;
  filteredCount: number;
  totalCount: number;
  activeFilters: readonly ActiveFilter[];
  searchTerm: string;
  sortField: string;
  sortDirection: 'asc' | 'desc';
  generatedAt: Date;
  /** SC-93 item 3 — withhold every column that discloses value. */
  hideAmounts?: boolean;
}

/** "Filtered — 12 of 69 holdings" / "All 69 holdings". The sentence the sheet
 *  shows and the About sheet repeats, so the two cannot disagree. */
export function describeExportScope<T>(input: DataViewExportInput<T>): string {
  const { config, filtered, filteredCount, totalCount } = input;
  const all = countLabel(totalCount, config.noun, config.nounSingular);
  if (!filtered) return `All ${all}`;
  return `Filtered — ${filteredCount} of ${all}`;
}

/**
 * What narrowed and ordered the list, in one line — used both as the scope
 * option's caption in the sheet and, split up, as the About sheet's rows.
 */
export function describeExportRefinement(
  activeFilters: readonly ActiveFilter[],
  searchTerm: string,
  sortField: string,
  sortDirection: 'asc' | 'desc',
  sortDefs: readonly SortDef[] | undefined
): { label: string; value: string }[] {
  const details: { label: string; value: string }[] = [];
  if (searchTerm) details.push({ label: 'Search', value: searchTerm });
  for (const filter of activeFilters) {
    details.push({ label: filter.label, value: filter.value });
  }
  const sortLabel = sortDefs?.find((def) => def.key === sortField)?.label;
  if (sortLabel) {
    details.push({
      label: 'Sorted by',
      value: `${sortLabel}, ${sortDirection === 'asc' ? 'low to high' : 'high to low'}`,
    });
  }
  return details;
}

/**
 * The rows in the order the grouped screen shows them, plus the runs.
 *
 * The list on screen is grouped by first appearance in sort order — that is
 * what `useDataView`'s `Map` does — and until SC-94 the file was the *flat*
 * sorted list with a group column beside it. Two orders for one list, and the
 * file's was the one nobody was looking at. Grouping here fixes that for every
 * format at once, and it is what lets the PDF print headings at all: a heading
 * is only possible over a contiguous run.
 */
function groupItems<T>(
  items: readonly T[],
  groupFn: (item: T) => string
): { ordered: T[]; groups: { label: string; rowCount: number }[] } {
  const runs = new Map<string, T[]>();
  for (const item of items) {
    const label = groupFn(item);
    const run = runs.get(label);
    if (run) run.push(item);
    else runs.set(label, [item]);
  }
  return {
    ordered: [...runs.values()].flat(),
    groups: [...runs.entries()].map(([label, run]) => ({ label, rowCount: run.length })),
  };
}

export function buildDataViewSheets<T>(input: DataViewExportInput<T>): ExportWorkbook {
  const { config, groupBy, generatedAt, hideAmounts } = input;

  const groupDef = groupBy ? config.groupByDefs?.find((def) => def.key === groupBy) : undefined;
  const groupFn = groupDef ? groupDef.fn || groupDef.groupFn : undefined;
  const grouped = groupFn ? groupItems(input.items, groupFn) : undefined;
  const items = grouped ? grouped.ordered : input.items;
  // Not when the table already has that column. Grouping `/holdings` by account
  // and exporting produced two adjacent columns both headed `Account` holding
  // identical values — a spreadsheet the reader has to look twice at to
  // discover says nothing. The grouping is only *information* in the file when
  // it is a dimension the columns do not already carry.
  const groupIsNewColumn =
    groupDef !== undefined &&
    !config.columns.some((column) => column.header.toLowerCase() === groupDef.label.toLowerCase());
  const fields: ExportField<T>[] = [
    ...(groupDef && groupIsNewColumn ? [groupField<T>(groupDef)] : []),
    ...config.columns.map(columnField),
  ];

  const details = describeExportRefinement(
    input.activeFilters,
    input.searchTerm,
    input.sortField,
    input.sortDirection,
    config.sortDefs
  );
  if (groupDef) details.push({ label: 'Grouped by', value: groupDef.label });

  const provenance: ExportProvenance = {
    subject: sentenceNoun(config.noun),
    scope: describeExportScope(input),
    generatedAt,
    details,
    rowCount: items.length,
    amountsWithheld: hideAmounts,
  };

  return {
    sheets: [
      buildSheet(sentenceNoun(config.noun), fields, items, {
        hideAmounts,
        groups: grouped?.groups,
        groupField: groupDef !== undefined && groupIsNewColumn,
      }),
    ],
    provenance,
  };
}

/** "holdings" → "Holdings". The nouns are stored lowercase because they are
 *  written mid-sentence everywhere else; a sheet tab and a title are not
 *  mid-sentence. */
export function sentenceNoun(noun: string): string {
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}
