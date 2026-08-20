import type { TFunction } from 'i18next';

/**
 * What a group is worth, and what that figure is allowed to claim.
 *
 * Three surfaces show this number — the group's page, the groups list, and the
 * home screen's groups block — so the reading of `groups.getValues` lives here
 * once. They were three different numbers before SC-87: the home block joined
 * the allocation cut client-side, and the other two showed no figure at all.
 *
 * The value arrives already in the user's base currency. Holdings are priced
 * server-side against it (`PortfolioValuationService`), so a group holding EUR
 * cash, a US-listed stock and a token is one comparable sum — there is no
 * second FX path here, and by SC-60's rule there must not be one.
 */

/** The row shape `groups.getValues` returns per group. */
export interface GroupValue {
  groupId: string;
  value: string;
  holdingsCounted: number;
  unpricedSymbols: string[];
}

export function groupValuesById(values: readonly GroupValue[]): Map<string, GroupValue> {
  return new Map(values.map((entry) => [entry.groupId, entry]));
}

/**
 * The figure to render, or `null` when there is no honest one.
 *
 * The distinction the null carries: a group holding nothing is worth zero and
 * says so, but a group whose every position is unpriceable is *unknown*, and
 * printing zero there would understate it by its whole value.
 */
export function groupAmount(value: GroupValue | undefined): number | null {
  if (!value) return null;
  if (value.holdingsCounted === 0 && value.unpricedSymbols.length > 0) return null;
  const parsed = Number.parseFloat(value.value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Biggest first, with the unpriced last in either direction — a group we could
 * not value is not a small one, and sorting it as zero says that it is.
 */
export function compareGroupAmounts(
  a: number | null,
  b: number | null,
  direction: 'asc' | 'desc'
): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return (a - b) * (direction === 'asc' ? 1 : -1);
}

/**
 * What the figure is a total of, in words, so it is not a number on its own.
 *
 * It states the count AND the list it is a subset of, because on the group this
 * was reported against the two differed and nothing said so: the figure covered
 * 22 holdings, the list under it showed 36, and the sentence called its 22 "the
 * active holdings in this group" — true of the total and not of the screen
 * (SC-388). "Covers 22 of the 36 listed below" cannot be read as a claim about
 * the list, and the sentences after it say where the other 14 went.
 *
 * `listed` is `null` while the membership queries are still in flight. The
 * figure and the list come from two queries and either can land first, so the
 * reconciling sentence is only written once there is a list to reconcile
 * against — a moment of "covers 22 of the 0" would be a worse defect than the
 * one this fixes.
 */
export function groupCoverageLine(
  value: GroupValue | undefined,
  listed: number | null,
  t: TFunction
): string {
  const counted = value?.holdingsCounted ?? 0;
  if (counted === 0) return t('v3.groups.coverage.empty');
  if (listed === null) return t('v3.groups.coverage.counted', { count: counted });
  if (listed <= counted) return t('v3.groups.coverage.countedAll', { count: counted });
  return t('v3.groups.coverage.countedOf', { count: counted, listed });
}

/**
 * The members the list shows and the total leaves out, as a sentence.
 *
 * A closed position stays in its group — it is still a thing the reader put
 * there and can take out — but `GroupValuationService` values active holdings
 * only. So the row is on screen and outside the figure directly above it, and
 * until SC-388 the only trace of that was an arithmetic gap the reader was left
 * to find. `null` when there are none, which is the ordinary case.
 */
export function inactiveGroupNote(inactive: number, t: TFunction): string | null {
  if (inactive <= 0) return null;
  return t('v3.groups.inactiveNote', { count: inactive });
}

/**
 * The standing-rule caveat, shown only on a group that actually has an account
 * in it. An account brings everything it holds and everything it later
 * receives, so a reader is owed both halves: why the figure moves on its own
 * after a sync, and that a position counted by its own row and by its
 * account's rule is still counted once.
 */
export const GROUP_ACCOUNT_NOTE_KEY = 'v3.groups.accountNote';

/**
 * Unpriceable positions, named beside the total rather than folded in.
 *
 * The symbols themselves are DATA and are never translated — a translator
 * turning "ETH" into anything else is a correctness bug (SC-201). What is
 * translated is the frame around them and the agreement that follows.
 *
 * FRAGILE, flagged not fixed: the two list frames hard-code an English
 * conjunction and comma, and `${head} and ${last}` assumes the last item goes
 * last. `Intl.ListFormat` is the right answer and belongs with step 5,
 * alongside the `join(', ')` currency lists in `ConvertedTotal`.
 */
export function unpricedGroupNote(symbols: readonly string[], t: TFunction): string | null {
  if (symbols.length === 0) return null;
  const named =
    symbols.length === 1
      ? symbols[0]
      : symbols.length <= 3
        ? t('v3.groups.unpriced.listAll', {
            head: symbols.slice(0, -1).join(', '),
            last: symbols.at(-1),
          })
        : t('v3.groups.unpriced.listMore', {
            head: symbols.slice(0, 2).join(', '),
            count: symbols.length - 2,
          });
  return t('v3.groups.unpriced.note', { count: symbols.length, named });
}
