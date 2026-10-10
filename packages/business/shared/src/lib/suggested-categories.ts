/**
 * The starter set of transaction categories, created only when a person asks
 * for it (SC-1652). The app names each key under `v3.categories.suggested`;
 * the API requires a name for every one of them.
 */
export const SUGGESTED_CATEGORIES: ReadonlyArray<{ key: string; children: readonly string[] }> = [
  { key: 'income', children: ['salary', 'interest', 'dividends'] },
  { key: 'housing', children: ['rent', 'utilities'] },
  { key: 'food', children: ['groceries', 'restaurants'] },
  { key: 'transport', children: [] },
  { key: 'health', children: [] },
  { key: 'shopping', children: [] },
  { key: 'travel', children: [] },
  { key: 'fees', children: ['bankFees', 'exchangeFees', 'taxes'] },
];

/** Every key in the starter set, parents and children alike. */
export const SUGGESTED_CATEGORY_KEYS: readonly string[] = SUGGESTED_CATEGORIES.flatMap((entry) => [
  entry.key,
  ...entry.children,
]);
