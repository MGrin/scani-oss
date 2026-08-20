/**
 * One dedup key that appeared more than once inside a single write batch.
 * `key` is how that key should read to a person; `dropped` is how many rows
 * were discarded onto it — occurrences minus the one that survived.
 */
export interface MergedRowKey {
  key: string;
  dropped: number;
}

/** The two nouns a collapse warning needs: what the row is, and what collided. */
export interface MergedRowSubject {
  /** Singular noun for the row, e.g. `transaction`, `coverage`. */
  row: string;
  /** The dedup key as a reader should see it, e.g. `(holding, source, externalId)`. */
  dedupKey: string;
}

/**
 * The one sentence a collapsed batch is described with. A repository that
 * has to dedupe a batch before Postgres sees it (`ON CONFLICT DO UPDATE`
 * refuses a statement carrying the conflict key twice) binds this rather
 * than wording its own: two descriptions of one event is how the next
 * reader ends up unsure whether they are the same problem. SC-349 is the
 * transaction ledger, SC-366 the coverage table.
 *
 * Null when nothing was merged, so a caller can push the result into its
 * `warnings` without first asking whether there is one.
 */
export function describeMergedBatch(
  merges: readonly MergedRowKey[],
  { row, dedupKey }: MergedRowSubject
): string | null {
  if (merges.length === 0) return null;
  const rowsDropped = merges.reduce((sum, m) => sum + m.dropped, 0);
  // Capped: this string is user-visible and is stored in the job result. A
  // statement import with hundreds of repeated rows would otherwise carry a
  // key list of several kilobytes into the UI, which buries the count that
  // actually tells an operator something.
  const SHOWN = 10;
  const keys = merges
    .slice(0, SHOWN)
    .map((m) => m.key)
    .join(', ');
  const rest = merges.length > SHOWN ? ` (+${merges.length - SHOWN} more)` : '';
  return (
    `${rowsDropped} ${row} row(s) across ${merges.length} dedup key(s) shared ` +
    `${dedupKey} with another row in the same batch and were merged ` +
    `into one. Keys: ${keys}${rest}`
  );
}
