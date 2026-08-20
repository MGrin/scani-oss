import type { UiTranslationKey } from '@scani/ui/v3/lib/data-view';

/**
 * The data-quality dimension of the Holdings list — the destination the
 * Settings panel's flagged rows link to (SC-293).
 *
 * SC-268 made those rows say **"Flagged"** rather than "Look into this",
 * because the panel was instructing an action it could not perform: not one
 * row was a control, and none could become one, since the report carried
 * counts and no ids. mgrin's answer to "who is this panel for" was to keep it
 * user-facing and make it work, and this module is the half of that which
 * lives on the reader's side.
 *
 * **A kind is a filter value, not a screen.** Three of the seven wanted a
 * Holdings filter that did not exist; the other four wanted a surface, and it
 * turned out they wanted the same one — a position with a duplicate symbol, a
 * homoglyph, a missing price source or a broken coverage row is still a
 * position, and the place positions are looked at is `/holdings`. Nothing here
 * needed a new screen, so nothing here got one.
 *
 * **The server names the set, and the count is its size.** That is what makes
 * a link safe to add: `getDataQualityReport` returns the holding ids behind
 * each kind and derives the row's number from `ids.length`, so the figure on
 * the panel and the length of the list it opens cannot disagree. A row whose
 * set the server did not name gets no link at all and keeps saying Flagged —
 * an inert honest row is what SC-268 bought and it is not for sale.
 */
export const DATA_QUALITY_KINDS = [
  'duplicateSymbol',
  'lookalike',
  'zeroBalance',
  'noRecentPrice',
  'noPriceSource',
  'negativeOpening',
  'noCoverage',
] as const;

export type DataQualityKind = (typeof DATA_QUALITY_KINDS)[number];

/**
 * The query parameter, and the filter key — they are the same string on
 * purpose. `data-view-url.ts` makes a filter's key its parameter name, so
 * `/holdings?quality=noCoverage` needs no bespoke reader: `V3DataView` seeds
 * its filters from the query string and the holdings config declares this
 * filter under this key.
 */
export const HOLDINGS_QUALITY_PARAM = 'quality';

/**
 * The Refine sheet's name for each kind.
 *
 * `ui.*` rather than `v3.*` because these are `V3FilterDef` option labels,
 * which resolve against `@scani/ui`'s own instance (SC-318) and therefore live
 * in the shell bundle alongside the four filter labels that were already
 * there. The panel's row labels stay `v3.*` — they are a different sentence
 * for a different reader, and forcing one string to serve both would give the
 * chip a full sentence and the row a two-word fragment.
 */
export const DATA_QUALITY_OPTION_KEYS: Record<DataQualityKind, UiTranslationKey> = {
  duplicateSymbol: 'ui.dataView.holdings.qualityOption.duplicateSymbol',
  lookalike: 'ui.dataView.holdings.qualityOption.lookalike',
  zeroBalance: 'ui.dataView.holdings.qualityOption.zeroBalance',
  noRecentPrice: 'ui.dataView.holdings.qualityOption.noRecentPrice',
  noPriceSource: 'ui.dataView.holdings.qualityOption.noPriceSource',
  negativeOpening: 'ui.dataView.holdings.qualityOption.negativeOpening',
  noCoverage: 'ui.dataView.holdings.qualityOption.noCoverage',
};

/** The holding ids behind each kind, as the report hands them over. Partial
 *  because an older API reports none, and a kind with no ids is a kind the
 *  list cannot offer. */
export type DataQualitySets = Partial<Record<DataQualityKind, readonly string[]>>;

export function isDataQualityKind(value: string): value is DataQualityKind {
  return (DATA_QUALITY_KINDS as readonly string[]).includes(value);
}

/**
 * The kinds this reader's data actually has, as `{ value, labelKey }` pairs.
 *
 * Empty sets are dropped rather than offered greyed out. A Refine option that
 * selects nothing is a control that answers "none" to a question the reader
 * did not know they were asking, and the panel already tells them which kinds
 * they have — offering "Zero balance" to someone with none makes the sheet
 * disagree with the panel.
 */
export function dataQualityOptions(
  sets: DataQualitySets | undefined
): { value: DataQualityKind; labelKey: UiTranslationKey }[] {
  if (!sets) return [];
  return DATA_QUALITY_KINDS.filter((kind) => (sets[kind]?.length ?? 0) > 0).map((kind) => ({
    value: kind,
    labelKey: DATA_QUALITY_OPTION_KEYS[kind],
  }));
}

/**
 * Membership, resolved once per filter application rather than per row.
 *
 * The predicate is an id-set lookup and not a re-derivation of the server's
 * rule — a client-side `amount === 0` would be a second implementation of
 * `zeroBalance`, and the day the two disagree is the day the panel's number
 * stops matching the list, which is the whole defect this ticket closes.
 *
 * Sets rather than the arrays as they arrive: the filter runs the predicate
 * once per holding on every keystroke in the search box, and `Array.includes`
 * over a few thousand ids makes that quadratic.
 */
export function qualityFilterFn(
  sets: DataQualitySets | undefined
): (holdingId: string, kind: string) => boolean {
  const byKind = new Map<string, ReadonlySet<string>>();
  for (const kind of DATA_QUALITY_KINDS) {
    const ids = sets?.[kind];
    if (ids && ids.length > 0) byKind.set(kind, new Set(ids));
  }
  return (holdingId, kind) => byKind.get(kind)?.has(holdingId) ?? false;
}
