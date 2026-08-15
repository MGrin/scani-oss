import type { ReactNode } from 'react';

/**
 * The peek sheet's content shape, and the URL arithmetic that makes it linkable.
 *
 * §2.2 of the research brief: a phone row carries three zones and the other
 * twelve data points move here. That only works if the sheet is a *place* —
 * `/v3/holdings/abc` — rather than a piece of component state. A record opened
 * from a list has to survive a share, a reload and the system back gesture, and
 * on Android the back gesture is how people close sheets. A state-only sheet
 * answers back by leaving the surface entirely, which loses the list.
 *
 * The URL half is pure functions here rather than logic inside the hook so the
 * cases that actually bite — a deeper path that only looks like a peek, an id
 * with a slash in it, a deep link that was never pushed — are testable without
 * a router or a DOM.
 */

/** One label/value pair. `value` is a node so a `<Numeric>` keeps its alignment
 *  and colour rather than being flattened to a string. */
export interface PeekFact {
  label: string;
  value: ReactNode;
}

/** A titled group of facts, shown below the fold. */
export interface PeekSection {
  title: string;
  facts: PeekFact[];
}

/**
 * What a record looks like in the sheet.
 *
 * The split is the design: `primary` is what has to be readable at the ~50%
 * rest height — four or five facts that answer "what is this and what is it
 * worth" — and `sections` is the depth reached by dragging up. A surface that
 * puts twelve facts in `primary` gets the thing this ticket replaced.
 */
export interface PeekSpec {
  title: string;
  subtitle?: string;
  /** Favicon or avatar, next to the title. */
  leading?: ReactNode;
  /** The one figure the record is about. */
  value?: ReactNode;
  delta?: ReactNode;
  /**
   * The figure's shape over time — a `<Sparkline>`, never a full chart.
   *
   * It sits with the figure rather than in the body because it is the same
   * claim measured a second way: a record whose trend scrolled out of view
   * would be answering "what is it worth" above the fold and "what did it do"
   * only for a reader who dragged. A chart with axes belongs on a page, and
   * the peek is deliberately not one.
   */
  trend?: ReactNode;
  primary: PeekFact[];
  /**
   * Body content that is not a label/value pair, between `primary` and
   * `sections` (SC-150).
   *
   * The escape hatch, and it stays one: a record whose peek needs a *choice*
   * cannot express that as facts. The transfer-review sheet asks which of
   * several deposits is the same money as the withdrawal being looked at, and
   * a list of eight candidates that the reader has to pick one of is an input,
   * not a fact — rendering it as `PeekFact.value` nodes would produce a column
   * of unlabelled controls under a `<dt>` that has nothing to say.
   *
   * It goes in the body rather than in `actions` deliberately. `actions` sits
   * in the sheet's *fixed* header, sized against the ~50% rest height, so a
   * chooser that opened there would push the record's own identity off a phone
   * screen at the moment the reader most needs to see it. Here it scrolls, and
   * what stays pinned is the thing being judged.
   */
  content?: ReactNode;
  sections?: PeekSection[];
  /** The two or three things you would open the record to do. */
  actions?: ReactNode;
}

/** A surface's peek declaration. `basePath` is the surface's own route; the
 *  record id is appended to it, so the surface must also register a
 *  `:peekId` child route or the deep link resolves to v3's catch-all. */
export interface PeekConfig<T> {
  basePath: string;
  render: (item: T) => PeekSpec;
}

/**
 * Marks a peek URL as one *we* pushed, so closing can go back through history
 * instead of pushing a second entry. Keyed by base path rather than a boolean:
 * a `state` object survives a client-side navigation between surfaces, and a
 * flag from the holdings peek must not convince the payments peek that its own
 * entry is poppable.
 */
export const PEEK_STATE_KEY = 'v3PeekFrom';

function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/**
 * The record id a URL is peeking at, or null.
 *
 * Exactly one segment below `basePath`. `/v3/holdings/a/b` is not a peek — it
 * is some deeper route — and treating it as the id `a` would open the wrong
 * sheet over the wrong screen.
 */
export function parsePeekId(pathname: string, basePath: string): string | null {
  const path = stripTrailingSlash(pathname);
  const base = stripTrailingSlash(basePath);
  if (!path.startsWith(`${base}/`)) return null;
  const rest = path.slice(base.length + 1);
  if (rest.length === 0 || rest.includes('/')) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    // A malformed escape is not an id. Better an unopened sheet than a throw
    // during render on someone else's mangled link.
    return null;
  }
}

/**
 * The URL a record is peeked at. Encoded, because ids are opaque and one with
 * a `/` in it would otherwise mint a route that `parsePeekId` rejects.
 *
 * `search` carries the list's own query string across. v3 never writes filters
 * to the URL, so this is only ever the query a *link* set — and dropping it
 * would make `/v3/holdings/h1` mean "this holding in the whole portfolio" when
 * the reader opened it out of one account's list. V3-40 makes that visible:
 * the tab bar lights Accounts on holdings narrowed to an account, so a peek
 * that dropped the filter would darken the bar on the way in and light it again
 * on the way out.
 */
export function peekPath(basePath: string, id: string, search = ''): string {
  const path = `${stripTrailingSlash(basePath)}/${encodeURIComponent(id)}`;
  const query = search.replace(/^\?/, '');
  return query.length > 0 ? `${path}?${query}` : path;
}

/** The history state a peek is opened with. Paired with `resolvePeekClose`,
 *  which reads it back — normalising in one place is what keeps a `basePath`
 *  written with a trailing slash from making its own peek unpoppable. */
export function peekOpenState(basePath: string): Record<string, string> {
  return { [PEEK_STATE_KEY]: stripTrailingSlash(basePath) };
}

export type PeekCloseAction = { type: 'back' } | { type: 'replace'; to: string };

/**
 * How to leave a peek.
 *
 * If we pushed the entry, pop it: closing and the back gesture then do the same
 * thing, and opening five records in a row does not bury the list five entries
 * deep. If we did not — the sheet was deep-linked, or restored on reload —
 * there is nothing of ours to pop, so replace with the list. `navigate(-1)`
 * there would leave the app, which is not what closing a sheet means.
 */
export function resolvePeekClose(basePath: string, state: unknown): PeekCloseAction {
  const pushedFrom =
    typeof state === 'object' && state !== null
      ? (state as Record<string, unknown>)[PEEK_STATE_KEY]
      : undefined;
  if (pushedFrom === stripTrailingSlash(basePath)) return { type: 'back' };
  return { type: 'replace', to: stripTrailingSlash(basePath) };
}
