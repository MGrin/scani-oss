/**
 * Transaction kinds that are neither income nor spending, so they take no
 * category and never count as uncategorized (SC-1720): trades, swaps,
 * settlements, transfers, opening balances and restatements.
 */
export const KINDS_OUTSIDE_CATEGORIES = [
  'buy',
  'sell',
  'swap_in',
  'swap_out',
  'settle_in',
  'settle_out',
  'transfer_in',
  'transfer_out',
  'opening_balance',
  'correction',
] as const;

/** A row outside categories: one of those kinds, or a linked transfer leg. */
export function isOutsideCategories(row: {
  kind: string;
  transferGroupId: string | null;
}): boolean {
  return (
    row.transferGroupId !== null ||
    (KINDS_OUTSIDE_CATEGORIES as readonly string[]).includes(row.kind)
  );
}

/**
 * Who sets a category for a person, as a guess they can Keep or change: a
 * learned rule, AI, or the row's type (SC-1695, SC-1720). The app marks these
 * "Set automatically".
 */
export const AUTO_CATEGORY_SOURCES = ['rule', 'ai', 'kind'] as const;
