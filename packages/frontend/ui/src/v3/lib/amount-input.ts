/**
 * The parsing half of `<AmountInput>` (SC-75), kept pure so the separator rules
 * are testable without a DOM.
 *
 * The bug this exists to make impossible: v3's numeric fields were
 * `react-number-format` with `thousandSeparator=","`, so a decimal comma was
 * *deleted* as a group separator and then re-inserted three digits later.
 * Typing `12,99` produced `1,299` — a comma sitting exactly where the reader
 * put one, over a number a hundred times too big. Nothing on screen said so.
 *
 * Three rules follow from that, and they are the whole design:
 *
 * - **Both `,` and `.` are the decimal separator.** Which one you get is the
 *   one you typed. The owner is European; `12,99` is the natural keystroke.
 * - **No grouping is ever inserted while the field is being edited.** The
 *   failure above needed a group separator to hide behind. There isn't one.
 * - **A separator is only grouping when it cannot be a decimal point** — it
 *   repeats (`1,234,567`), the other kind appears after it (`1.234,56`), or
 *   the field holds no decimals at all.
 *
 * The residual ambiguity is a single separator followed by exactly three
 * digits: `1,234` is one-point-two-three-four to a European and one thousand
 * to an American. We read it as a decimal point, because that is what keeps
 * typing monotonic — every prefix of `1,234` must mean what its next keystroke
 * will confirm — and we flag it so the caller can say so out loud.
 */

/** Characters that only ever group digits, never separate a decimal: ASCII
 *  space, NBSP, narrow NBSP, thin space, figure space, and the apostrophes
 *  Swiss and older German typography use. A bank statement carries these. */
const GROUPING_ONLY = /[\s    '’`]/g;

/** U+2212, which `<Numeric>` emits — so a figure copied out of the app and
 *  pasted back into a field round-trips. */
const MINUS_SIGN = /^[-−]/;

export interface AmountRules {
  /** Digits allowed after the separator. `0` makes the field integers-only,
   *  which also makes every separator in it grouping. */
  decimalScale?: number;
  allowNegative?: boolean;
}

export interface ParsedAmount {
  /** What the field shows: the reader's own separator, kept verbatim. */
  text: string;
  /** What the form submits — `-?\d+(\.\d+)?`, or `''` for no value. */
  value: string;
  /** The input was read one of two defensible ways and we picked one. The
   *  caller must surface this; see the note above about `1,234`. */
  ambiguous: boolean;
}

const EMPTY: ParsedAmount = { text: '', value: '', ambiguous: false };

/**
 * Reads one candidate string — a keystroke's worth of new input, a paste, or a
 * whole pre-filled value — into what to show and what to submit.
 *
 * Applied to the *entire* field contents on every edit rather than to single
 * keypresses, which is what makes typing and pasting the same code path.
 */
export function parseAmountInput(raw: string, rules: AmountRules = {}): ParsedAmount {
  const { decimalScale = 2, allowNegative = false } = rules;

  const stripped = raw.replace(GROUPING_ONLY, '');
  if (stripped === '') return EMPTY;

  const negative = allowNegative && MINUS_SIGN.test(stripped);
  const body = stripped.replace(/[^0-9.,]/g, '');
  if (body === '') return EMPTY;

  // `1,234` in an integer field is a thousand, and nothing else it could be.
  if (decimalScale === 0 && isGrouped(body)) {
    const whole = body.replace(/[.,]/g, '');
    const sign = negative ? '-' : '';
    return { text: `${sign}${whole}`, value: `${sign}${whole}`, ambiguous: false };
  }

  const decimalAt = findDecimalSeparator(body);
  const separator = decimalAt === -1 ? '' : (body[decimalAt] as string);
  const whole = (decimalAt === -1 ? body : body.slice(0, decimalAt)).replace(/[.,]/g, '');
  const typedFraction = decimalAt === -1 ? null : body.slice(decimalAt + 1).replace(/[.,]/g, '');

  // Three digits behind a lone separator, over a whole part shaped like a
  // leading group: `1,234` reads as a decimal here and as a thousand in every
  // figure the app prints. We keep the decimal reading — see the header — and
  // flag it. Judged on what was typed, before truncation below can hide it.
  const ambiguous =
    (typedFraction !== null && typedFraction.length === 3 && /^[1-9]\d{0,2}$/.test(whole)) ||
    // An integer field that was handed a decimal point: the fraction is going
    // to be dropped, and the reader has to be told which number survived.
    (decimalScale === 0 && (typedFraction ?? '') !== '');

  // **The scale truncates the value, never the text.** Two separate failures
  // come from truncating what is on screen, and both are SC-75 again:
  //
  // - Dropping a separator lets the next digit close over the gap. `12,99` in
  //   the integer interval field became 1299.
  // - Truncating early destroys digits that a *later* keystroke would have
  //   reinterpreted. Typing `1,234.56` into a 2-decimal field stalled at
  //   `1,23` and never saw the `.` that proves the comma was grouping.
  //
  // Everything typed stays visible; blur then shows what was actually taken.
  const textFraction = typedFraction;
  const fraction = typedFraction === null ? null : typedFraction.slice(0, decimalScale);

  const sign = negative && (whole !== '' || (textFraction ?? '') !== '') ? '-' : '';
  const text = `${sign}${whole}${textFraction === null ? '' : separator + textFraction}`;

  if (whole === '' && (textFraction ?? '') === '') {
    // `,` or `.` alone: not a number yet, but dropping the keystroke would be
    // the exact swallow this module exists to prevent, so it stays on screen.
    return { text, value: '', ambiguous: false };
  }

  const value = `${sign}${whole === '' ? '0' : whole}${
    fraction !== null && fraction !== '' ? `.${fraction}` : ''
  }`;

  return { text, value, ambiguous };
}

/**
 * Index of the character acting as the decimal point, or `-1` when every
 * separator present is grouping.
 *
 * The load-bearing rule is that **grouping has to look like grouping**. Reading
 * any repeated separator as grouping is what re-opens SC-75 from the other
 * side: `12,99` plus one more `,` would become `1299`, a hundredfold jump off
 * a keystroke that should simply have been refused. So a separator is only
 * grouping when the digits around it form real thousands groups; otherwise the
 * first separator is the decimal point and the extras are rejected.
 */
function findDecimalSeparator(input: string): number {
  const firstComma = input.indexOf(',');
  const firstDot = input.indexOf('.');
  if (firstComma === -1 && firstDot === -1) return -1;

  const firstAt =
    firstComma === -1 ? firstDot : firstDot === -1 ? firstComma : Math.min(firstComma, firstDot);
  const lastAt = Math.max(input.lastIndexOf(','), input.lastIndexOf('.'));

  if (firstAt === lastAt) return lastAt;

  const last = input[lastAt] as string;
  // The last separator is the decimal point when it occurs once and everything
  // ahead of it groups cleanly: `1,234.56` and `1.234,56` are both 1234.56.
  if (countOf(input, last) === 1 && isGrouped(input.slice(0, lastAt))) return lastAt;

  // One kind, repeated, in well-formed groups — `1,234,567` is an integer.
  if (isGrouped(input)) return -1;

  return firstAt;
}

function countOf(input: string, character: string): number {
  return input.split(character).length - 1;
}

/** Digits split by one repeated separator into a 1-3 digit head and 3-digit
 *  tails, with no leading zero — the only shape a grouped number can take. */
function isGrouped(input: string): boolean {
  return /^[1-9]\d{0,2}([.,])\d{3}(\1\d{3})*$/.test(input);
}

/**
 * The canonical rendering of a submitted value: `en-US`, because every figure
 * the app *prints* is `en-US` (`@scani/shared`'s formatters default to it).
 *
 * Shown whenever the field is not being edited, so the reader is always told
 * which number was understood — `12,99` typed comes back as `12.99`, and a
 * `1,234` that was meant as a thousand comes back as `1.234`, where the reader
 * can see it rather than discover it in the portfolio total a week later.
 *
 * The fraction is echoed verbatim rather than re-rounded, so a deliberate
 * `12.30` does not come back as `12.3`.
 */
export function formatAmountForDisplay(value: string, suffix = ''): string {
  if (value.trim() === '') return '';
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '', fraction] = unsigned.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}${grouped}${fraction === undefined ? '' : `.${fraction}`}${suffix}`;
}
