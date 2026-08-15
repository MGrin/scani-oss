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

/** What the figure is a total of, in words, so it is not a number on its own. */
export function groupCoverageLine(value: GroupValue | undefined): string {
  const counted = value?.holdingsCounted ?? 0;
  if (counted === 0) return 'Nothing in this group carries a value today.';
  return counted === 1
    ? 'What the 1 active holding in this group is worth today.'
    : `What the ${counted} active holdings in this group are worth today.`;
}

/**
 * The derived-membership caveat, shown only on a group that actually has an
 * account in it. An account is in a group iff every visible holding in it is,
 * so the two membership paths overlap and a reader is owed the fact that the
 * overlap is not added twice.
 */
export const GROUP_ACCOUNT_NOTE =
  'An account here counts through its own holdings, so a holding in both is counted once.';

/** Unpriceable positions, named beside the total rather than folded in. */
export function unpricedGroupNote(symbols: readonly string[]): string | null {
  if (symbols.length === 0) return null;
  const named =
    symbols.length === 1
      ? symbols[0]
      : symbols.length <= 3
        ? `${symbols.slice(0, -1).join(', ')} and ${symbols.at(-1)}`
        : `${symbols.slice(0, 2).join(', ')} and ${symbols.length - 2} more`;
  return `${named} could not be priced today, so ${symbols.length === 1 ? 'it is' : 'they are'} not in this total.`;
}
