import type { JobNotice, JobNoticeList } from '../types';

const TYPES_NAMED = 4;

/**
 * The upstream types a provider could not place, as a keyed list (SC-1028).
 *
 * Each type is named verbatim because the string is the actionable part: it is
 * what has to be added to the map, so a reader who forwards the warning has
 * forwarded the whole bug report. Past the first few, the remainder is one
 * keyed item of the same list, so every plural is the client's `count` rather
 * than an English suffix.
 */
export function namedTypeCounts(
  counts: ReadonlyMap<string, number>,
  furtherTypesKey: string
): { types: JobNoticeList; total: number } | null {
  if (counts.size === 0) return null;
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const items: JobNotice[] = rows
    .slice(0, TYPES_NAMED)
    .map(([type, n]) => ({ key: null, text: `"${type}" (${n})` }));
  const rest = rows.length - items.length;
  if (rest > 0) {
    items.push({
      key: furtherTypesKey,
      params: { count: rest },
      text: `${rest} further type${rest === 1 ? '' : 's'}`,
    });
  }
  const total = rows.reduce((sum, [, n]) => sum + n, 0);
  return { types: { type: 'conjunction', items }, total };
}
