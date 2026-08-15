import { formatCurrency, UNPRICEABLE_PLACEHOLDER } from '@scani/shared';
import { toFiniteNumber } from '@scani/ui/v3/lib/numeric';

/**
 * The pure half of the net-worth hero — §5.4 of the design brief, "the tape".
 *
 * The hero is the one figure in v3 that is *composed* rather than printed:
 * the integer part carries the display size, the currency symbol and the cents
 * are demoted to `caption` and ride the top and bottom of the integer's band,
 * and thousands are grouped by a **narrow separator** — the locale's own
 * grouping glyph, drawn in a cell about a third of a digit wide rather than in
 * the full one a monospaced face would give it.
 *
 * That is a correction (SC-71 6.2). The separator used to be a blank of the
 * same narrow width, on the reasoning that a comma spends a whole cell to
 * carry no information — true about the *cell*, false about the glyph. All
 * three QA surfaces independently reported the result: the hero read
 * `€602 641.80` while the delta chip one line below it read `+€7,209.93`, and
 * every other screen in the app printed the same figure as `€599,511.02`. One
 * figure with two separators on one card is the reader's problem, not the
 * typesetter's; keeping the *cell* narrow is what the monospace argument
 * actually buys, and that is kept.
 *
 * Splitting that out here keeps the two things that are easy to get wrong
 * testable without a DOM: which glyph belongs in which band, and the fact that
 * the accessible string is the ordinary formatted currency rather than the
 * decomposed one. A screen reader must hear "$128,432.10", not a symbol, then
 * a run of digit cells, then a fraction.
 */

/** U+2212, matching `<Numeric>` — a hyphen is narrower than a digit cell. */
const MINUS = '−';

export interface TapeParts {
  /** Display-size, because a negative net worth is a fact about the figure. */
  sign: '' | typeof MINUS;
  /** Caption-size, riding the top of the integer band. */
  symbol: string;
  /** Thousands groups, largest first: `128,432.10` → `['128', '432']`. */
  groups: string[];
  /** The locale's thousands separator — `,` for `en-US`. Empty when the figure
   *  has only one group, i.e. when nothing is grouped. */
  group: string;
  /** Locale decimal separator, or `''` when there is no fraction. */
  decimal: string;
  /** Caption-size, riding the bottom of the integer band. */
  fraction: string;
  /** What assistive tech reads. The ordinary formatted figure. */
  accessibleText: string;
  isPlaceholder: boolean;
}

const PLACEHOLDER: TapeParts = {
  sign: '',
  symbol: '',
  groups: [UNPRICEABLE_PLACEHOLDER],
  group: '',
  decimal: '',
  fraction: '',
  accessibleText: 'No value',
  isPlaceholder: true,
};

interface SplitParts {
  symbol: string;
  groups: string[];
  group: string;
  decimal: string;
  fraction: string;
}

/**
 * `formatToParts` rather than a regex over the formatted string: it names the
 * symbol, every thousands group and the fraction directly, so the split holds
 * for a currency whose symbol is a three-letter code or whose separator is not
 * a comma.
 *
 * The fallback mirrors `formatCurrency`'s own: `Intl` throws on a currency
 * code it does not recognise, and Scani token symbols include private-equity
 * tickers that are not ISO codes.
 */
function splitParts(absolute: number, currency: string, decimals: number): SplitParts {
  const options = { minimumFractionDigits: decimals, maximumFractionDigits: decimals } as const;
  let parts: Intl.NumberFormatPart[];
  let symbol: string;
  try {
    parts = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      ...options,
    }).formatToParts(absolute);
    symbol = parts
      .filter((part) => part.type === 'currency')
      .map((part) => part.value)
      .join('');
  } catch {
    parts = new Intl.NumberFormat('en-US', options).formatToParts(absolute);
    symbol = currency;
  }

  return {
    symbol,
    groups: parts.filter((part) => part.type === 'integer').map((part) => part.value),
    // Read off `formatToParts` rather than assumed to be a comma: the same
    // reason the decimal separator is. A locale that groups with a period or a
    // narrow no-break space gets its own glyph, not `en-US`'s.
    group: parts.find((part) => part.type === 'group')?.value ?? '',
    decimal: parts.find((part) => part.type === 'decimal')?.value ?? '',
    fraction: parts.find((part) => part.type === 'fraction')?.value ?? '',
  };
}

export function composeTape(
  value: number | string | null | undefined,
  currency: string,
  decimals = 2
): TapeParts {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return PLACEHOLDER;

  // Rounded before the sign is read, for the reason `resolveNumeric` gives:
  // a value that displays as zero must not be labelled negative.
  const rounded = Number(numeric.toFixed(decimals));
  const { symbol, groups, group, decimal, fraction } = splitParts(
    Math.abs(rounded),
    currency,
    decimals
  );

  return {
    sign: rounded < 0 ? MINUS : '',
    symbol,
    groups,
    group,
    decimal,
    fraction,
    // The hyphen `formatCurrency` emits is left alone: this string is never
    // rendered, and a screen reader announces U+2212 less reliably.
    accessibleText: formatCurrency(rounded, currency, { decimals }),
    isPlaceholder: false,
  };
}

export type TapeCell =
  /** One glyph in a full-width cell. Digits roll; a sign does not. */
  | { kind: 'glyph'; char: string; rolls: boolean }
  /** The separator between thousands groups, in a cell narrower than a digit's
   *  — that is the point. It carries the locale's own grouping glyph. */
  | { kind: 'group'; char: string };

/**
 * The integer run as the cells that get rendered, in order.
 *
 * Cells rather than a string because the roll (§5.4) needs to address a single
 * digit, and because the separator is not one of them: it is drawn in a cell of
 * its own, sized independently of the monospaced advance width, and it never
 * rolls — a comma that animated into a comma is motion carrying nothing.
 */
export function tapeCells(parts: TapeParts): TapeCell[] {
  const cells: TapeCell[] = [];
  if (parts.sign) cells.push({ kind: 'glyph', char: parts.sign, rolls: false });
  parts.groups.forEach((group, index) => {
    if (index > 0 && parts.group) cells.push({ kind: 'group', char: parts.group });
    for (const char of group) cells.push({ kind: 'glyph', char, rolls: !parts.isPlaceholder });
  });
  return cells;
}

/**
 * For each cell, the glyph it is rolling *from*, or `null` if it is not
 * rolling. Aligned from the RIGHT.
 *
 * Right-alignment is what makes the roll mean anything once the figure crosses
 * a power of ten: `$99 998 → $100 002` shares its last four columns with the
 * old figure by position from the end, and index-from-the-left would call every
 * one of them changed and re-roll the whole number.
 */
export function rollFrom(
  previous: readonly TapeCell[],
  next: readonly TapeCell[]
): (string | null)[] {
  const offset = next.length - previous.length;
  return next.map((cell, index) => {
    if (cell.kind !== 'glyph' || !cell.rolls) return null;
    const before = previous[index - offset];
    // A cell with no predecessor — the figure grew a digit — has nothing to
    // roll from and appears in place. Rolling it from a blank would read as a
    // digit changing when what happened is the number got longer.
    if (before === undefined || before.kind !== 'glyph') return null;
    return before.char === cell.char ? null : before.char;
  });
}
