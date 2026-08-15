import {
  formatCompact,
  formatCurrency,
  formatNumber,
  moneyDecimals,
  UNPRICEABLE_PLACEHOLDER,
} from '@scani/shared';

/**
 * The formatting half of `<Numeric>` (V3-07), kept pure so the rules about
 * sign, tone and rounding are testable without rendering React.
 *
 * Two decisions worth knowing before reading the code:
 *
 * - **Sign is derived from the value the user will actually see**, not from the
 *   raw input. `-0.004` displayed at two decimals is `$0.00`, and labelling it
 *   a loss with a down arrow would be reporting a change that reads as zero.
 * - **A non-finite input is a placeholder, not a zero.** `@scani/shared`'s
 *   `formatCurrency` deliberately renders `NaN` as `$0.00` so no v2 caller had
 *   to sanitize first; in v3 a figure that isn't a number renders as `—`,
 *   because "$0.00" is a claim about money and `—` is a claim about knowledge.
 */

export type NumericFormat = 'currency' | 'percent' | 'plain';

/** `null` when the figure is a magnitude rather than a change — a magnitude
 *  carries no gain/loss meaning and must not be coloured. */
export type NumericTone = 'gain' | 'loss' | 'neutral';

/** U+2212. A hyphen-minus is narrower than a digit even in a monospaced face,
 *  so it breaks the digit grid a ledger column exists to hold. */
const MINUS = '−';
const ARROW_UP = '↑';
const ARROW_DOWN = '↓';

export interface NumericOptions {
  format?: NumericFormat;
  /** Required for `currency`; ignored otherwise. */
  currency?: string;
  decimals?: number;
  /** Compact currency notation ("$1.2K"). `currency` format only. */
  compact?: boolean;
  /** A change rather than a magnitude: signed, toned, and carrying an arrow. */
  delta?: boolean;
}

export interface NumericParts {
  /** `null` for a magnitude — see `NumericTone`. */
  tone: NumericTone | null;
  sign: '' | '+' | typeof MINUS;
  arrow: '' | typeof ARROW_UP | typeof ARROW_DOWN;
  /** Formatted, unsigned for a delta and signed for a magnitude. */
  magnitude: string;
  /** What a screen reader should read: the sign and the figure, no arrow. */
  text: string;
  isPlaceholder: boolean;
}

const PLACEHOLDER_PARTS: NumericParts = {
  tone: null,
  sign: '',
  arrow: '',
  magnitude: UNPRICEABLE_PLACEHOLDER,
  text: UNPRICEABLE_PLACEHOLDER,
  isPlaceholder: true,
};

export function toFiniteNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // `Number('')` and `Number('  ')` are 0, which would render an empty string
  // as $0.00.
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The number of decimals the formatter below will actually show, so the sign
 * can be taken from the rounded figure. `null` means "no rounding applied".
 *
 * **A money magnitude gets the decimals its magnitude needs** (SC-179). Two is
 * right down to a cent and wrong below one: a unit price of €0.0000771 rendered
 * `€0.00` beside a balance of 4,200,000 units and a value of €324.03, so the
 * row disproved its own arithmetic — on the screen and in the PDF statement
 * built from it, which is the copy that goes to an accountant.
 *
 * A **delta** keeps its fixed two, deliberately. The rule directly above — that
 * the sign comes from the figure the reader sees — exists so a change of
 * `-0.004` is not reported as a loss with a red arrow, and extending its
 * precision until it is non-zero would undo exactly that. A magnitude has no
 * sign to overstate; a change does.
 */
function displayedDecimals(
  absolute: number,
  { format = 'currency', decimals, compact = false, delta = false }: NumericOptions
): number | null {
  if (format === 'currency') {
    // `formatCompact` falls back to the plain formatter below 1,000, since
    // "$0.5K" is silly — so the precision changes at that boundary too.
    if (compact) return absolute < 1_000 ? (decimals ?? 0) : 1;
    if (decimals !== undefined) return decimals;
    return delta ? 2 : moneyDecimals(absolute);
  }
  if (format === 'percent') return decimals ?? 2;
  return decimals ?? null;
}

/** Formatted at the precision `displayedDecimals` already settled on, so the
 *  figure the reader sees and the figure the sign was taken from are one. */
function formatMagnitude(value: number, options: NumericOptions, precision: number | null): string {
  const { format = 'currency', currency = 'USD', decimals, compact = false } = options;
  if (format === 'currency') {
    return compact
      ? formatCompact(value, currency, decimals === undefined ? {} : { decimals })
      : formatCurrency(value, currency, { decimals: precision ?? 2 });
  }
  if (format === 'percent') {
    return `${formatNumber(value, { decimals: precision ?? 2 })}%`;
  }
  return formatNumber(value, precision === null ? {} : { decimals: precision });
}

/** Every `-` Intl emits becomes U+2212 so one column never mixes the two. */
function normalizeMinus(formatted: string): string {
  return formatted.replace(/-/g, MINUS);
}

export function resolveNumeric(
  value: number | string | null | undefined,
  options: NumericOptions = {}
): NumericParts {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return PLACEHOLDER_PARTS;

  const { delta = false } = options;
  const absolute = Math.abs(numeric);
  const precision = displayedDecimals(absolute, options);
  const displayed = precision === null ? numeric : Number(numeric.toFixed(precision));
  const direction = Math.sign(displayed);

  const magnitude = normalizeMinus(formatMagnitude(delta ? absolute : numeric, options, precision));

  if (!delta) {
    return { tone: null, sign: '', arrow: '', magnitude, text: magnitude, isPlaceholder: false };
  }

  // Zero is neutral, not green — §5.1 rule 3 of the design brief — and carries
  // no sign or arrow, because there is no direction to indicate.
  const tone: NumericTone = direction > 0 ? 'gain' : direction < 0 ? 'loss' : 'neutral';
  const sign = direction > 0 ? '+' : direction < 0 ? MINUS : '';
  const arrow = direction > 0 ? ARROW_UP : direction < 0 ? ARROW_DOWN : '';

  return { tone, sign, arrow, magnitude, text: `${sign}${magnitude}`, isPlaceholder: false };
}
