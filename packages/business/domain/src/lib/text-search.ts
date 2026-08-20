/**
 * A user's search box term, turned into a pattern `ILIKE` can be trusted with.
 *
 * Two jobs, and the second is the one that is easy to miss: `%` and `_` are
 * wildcards inside a `LIKE` pattern, so a term of `_` matches every row and a
 * term of `%` matches every row twice as fast. Both are ordinary characters in
 * a filename. They are escaped with a backslash, which is Postgres's default
 * `LIKE` escape character, so no `ESCAPE` clause is needed at the call site.
 *
 * Returns `null` for a term that is empty once trimmed — a positive statement
 * that there is nothing to search for, rather than a `'%%'` pattern that reads
 * as a search and matches everything.
 */
export function ilikePattern(term: string | undefined | null): string | null {
  const trimmed = (term ?? '').trim();
  if (trimmed.length === 0) return null;
  return `%${trimmed.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
