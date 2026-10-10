export class CategoryNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CategoryNameError';
  }
}

const MAX_NAME = 60;

/** A category name as stored: trimmed, inner whitespace collapsed, 1–60 characters. */
export function normalizeCategoryName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length === 0) throw new CategoryNameError('A category needs a name.');
  if (name.length > MAX_NAME) {
    throw new CategoryNameError(`A category name is at most ${MAX_NAME} characters.`);
  }
  return name;
}

// YNAB's own bookkeeping, not spending: money waiting to be budgeted.
const NOT_A_CATEGORY = [
  /^inflow: (ready to assign|to be budgeted)$/i,
  /^internal master category\b/i,
];

/**
 * A budget app's category string as a parent and an optional child. YNAB and
 * Actual write `Group: Name`; Mint writes a flat name (SC-1652).
 */
export function parseImportedCategory(
  raw: string | null
): { parent: string; child: string | null } | null {
  const text = raw?.trim();
  if (!text || NOT_A_CATEGORY.some((pattern) => pattern.test(text))) return null;
  const at = text.indexOf(': ');
  if (at < 0) return { parent: text, child: null };
  const parent = text.slice(0, at).trim();
  const child = text.slice(at + 2).trim();
  if (!parent) return child ? { parent: child, child: null } : null;
  return { parent, child: child || null };
}
