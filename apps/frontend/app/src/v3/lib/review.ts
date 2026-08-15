import { counterpartPath } from './ui-version';

/**
 * The review feed's pure half — where a row goes, and how the feed is sliced.
 *
 * `review.listPending` is a read-model over several producers, and every item
 * carries the unprefixed path of the surface that owns it (`/jobs/<id>`,
 * `/documents/<id>`). That is the server's contract and neither interface gets
 * to change it: the same endpoint feeds v2's page and the home screen's
 * attention row, so the href stays version-neutral and the translation belongs
 * on the reading side.
 */

/** The fields the feed's own logic reads. */
export interface ReviewRow {
  /** `job:<jobId>` / `extraction:<id>` — namespaced by the producer, because
   *  two producers can hand out the same underlying row id. */
  id: string;
  kind: string;
  title: string;
  subtitle?: string | null;
  href: string;
  createdAt: string;
}

/**
 * Row prefixes whose v3 surface exists today. Jobs shipped in V3-15, a
 * document's page with V3-43, and the feed hands out nothing else — so the
 * translation below is a no-op for every row the server currently produces.
 *
 * It stays because the server's contract is the one thing this module does not
 * control. A producer added later hands out its own path, and the honest answer
 * for a screen v3 has not built is the classic one, not a v3 route that
 * resolves to the catch-all and bounces the reader home.
 */
const V3_OWNED_PREFIXES: readonly string[] = ['/jobs/', '/documents/'];

/**
 * Whole paths v3 owns, as opposed to `<prefix>/<id>` ones.
 *
 * The transfer queue (SC-150) is a single surface, not a record — its feed row
 * is the queue's count rather than one transfer — so it has no id segment and
 * cannot be matched by a prefix. It needs an exact entry, and it needs one at
 * all because **v2 has no such screen**: without this the feed's own row would
 * send the reader to `/v2/review/transfers`, which is a 404 reached by
 * clicking the thing that told them something needed doing.
 */
const V3_OWNED_PATHS: readonly string[] = ['/review/transfers'];

/**
 * The feed's hrefs are version-neutral by construction — v3 took the root in
 * V3-19, so a row's `/jobs/<id>` is already v3's own path and only a row v3
 * cannot render has to be sent across to `/v2`.
 */
export function reviewHref(href: string): string {
  const owned =
    V3_OWNED_PATHS.includes(href) || V3_OWNED_PREFIXES.some((prefix) => href.startsWith(prefix));
  return owned ? href : counterpartPath(href, 'v2');
}

export interface ReviewSubtitleParts {
  /** What is left of the subtitle once the figure is taken out of it, or null
   *  when the subtitle was nothing but a figure. */
  detail: string | null;
  amount: { value: number; currency: string } | null;
}

/**
 * `Albert Heijn — 87.31 EUR` → a name and a figure (SC-71 10.3).
 *
 * A review row's amount arrived inline in the muted subtitle as a raw string,
 * with the currency as a trailing **code** rather than the symbol every other
 * figure in v3 uses, unaligned with anything — while the right-hand column,
 * which holds the value on every other list in the app, held a timestamp. The
 * feed is one surface among a dozen and it was the only one spelling money that
 * way.
 *
 * Parsed here rather than fixed at the source because the subtitle is
 * `review.listPending`'s contract, shared with v2's page and the home screen's
 * attention row; splitting the DTO is a change to all three. `summariseExtraction`
 * is the only producer that emits a figure and it emits exactly this shape, so
 * the pattern is pinned to it — and anything that does not match is left whole,
 * which is the same failure mode the feed has today rather than a new one.
 */
/**
 * An **ISO 4217 code** — three uppercase letters — not "a word after a number".
 * The looser pattern read `2 files` as two of a currency called FILES, which is
 * the shape every other summariser emits: `3 holdings`, `4 transactions`,
 * `2 candidates`. A row that is a count is not a row that is money.
 */
const SUBTITLE_AMOUNT = /^(?:(.*?)\s+—\s+)?(-?\d[\d,]*(?:\.\d+)?)\s+([A-Z]{3})$/;

export function splitReviewSubtitle(subtitle: string | null | undefined): ReviewSubtitleParts {
  const text = subtitle?.trim();
  if (!text) return { detail: null, amount: null };

  const match = SUBTITLE_AMOUNT.exec(text);
  if (!match) return { detail: text, amount: null };

  const value = Number(match[2]?.replace(/,/g, ''));
  if (!Number.isFinite(value)) return { detail: text, amount: null };

  return {
    detail: match[1]?.trim() || null,
    amount: { value, currency: match[3] as string },
  };
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
  return (
    item.title.toLowerCase().includes(query) || (item.subtitle ?? '').toLowerCase().includes(query)
  );
}
