/**
 * The review feed's pure half — how the feed is sliced.
 *
 * `review.listPending` is a read-model over several producers, and every item
 * carries the path of the surface that owns it (`/jobs/<id>`,
 * `/documents/<id>`). That is the server's contract and this module does not
 * get to change it.
 *
 * It used to translate those hrefs (SC-423 removed it). v3 took the root in
 * V3-19, so a row's path was already v3's own and the translation was a no-op
 * for every row the server actually produced; the table existed only to hand a
 * surface v3 had not built to the classic interface instead. There is no
 * classic interface to hand it to, and a path v3 does not route now reaches a
 * not-found screen that quotes the address rather than a blank page — so a
 * future producer's unbuilt surface fails legibly instead of being routed
 * somewhere it also does not exist.
 */

/**
 * The fields the feed's own logic reads — a row that has already been NAMED.
 *
 * The wire carries operands (SC-371); `toReviewRow` in `review-text.ts` turns
 * one into this. Everything below — the filter's labels, the sort, the search
 * — reads what the reader reads, which is the only thing it can honestly sort
 * and match on once the words depend on a locale.
 */
export interface ReviewRow {
  /** `job:<jobId>` / `extraction:<id>` — namespaced by the producer, because
   *  two producers can hand out the same underlying row id. */
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  amount: { value: number; currency: string } | null;
  /** Every word the row puts on screen, including the figure in the digits
   *  the extractor recorded — `42.50`, not the `42.5` a float would search
   *  as. Searching the rendered row rather than the wire is the point: a
   *  reader types what they can see. */
  search: string;
  href: string;
  createdAt: string;
}

export interface ReviewKindOption {
  value: string;
  label: string;
}

/**
 * One filter option per kind present in the feed, labelled with the title that
 * kind shows on its rows — the feed has no separate name for a kind, and
 * "screenshot-parse" in a filter sheet over rows that all say "Document parse"
 * reads as a different thing entirely.
 */
export function reviewKindOptions(items: readonly ReviewRow[]): ReviewKindOption[] {
  const byKind = new Map<string, string>();
  for (const item of items) {
    if (!byKind.has(item.kind)) byKind.set(item.kind, item.title);
  }
  return [...byKind.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function compareReviewItems(
  a: ReviewRow,
  b: ReviewRow,
  field: string,
  direction: string
): number {
  const mult = direction === 'asc' ? 1 : -1;
  switch (field) {
    case 'title':
      return a.title.localeCompare(b.title) * mult;
    case 'arrived':
      return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * mult;
    default:
      return 0;
  }
}

/** `query` arrives already lower-cased from `useDataView`. */
export function reviewMatches(item: ReviewRow, query: string): boolean {
  return item.search.toLowerCase().includes(query);
}
