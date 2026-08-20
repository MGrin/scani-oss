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
 *
 * **Only where the reader's own locale groups with that character** (SC-417).
 * The reading above never changes, but the doubt is not universal: Russian
 * groups with a space, so a Russian reader's `1,234` is one-point-two-three-
 * four and nothing else, and Spanish groups with `.`, so theirs is the other
 * character. See `couldBeGrouping`.
 */

import { getFormatLocale } from '@scani/shared';

/** Characters that only ever group digits, never separate a decimal: ASCII
 *  space, NBSP, narrow NBSP, thin space, figure space, and the apostrophes
 *  Swiss and older German typography use. A bank statement carries these. */
const GROUPING_ONLY = /[\s    '’`]/g;

/** U+2212, which `<Numeric>` emits — so a figure copied out of the app and
 *  pasted back into a field round-trips. */
const MINUS_SIGN = /^[-−]/;

/**
 * The invisible marks `Intl` wraps a signed figure in — U+061C before the
 * hyphen in `ar-EG`, U+200E in bare `ar` (measured, Bun 1.3.14).
 *
 * Stripped before anything else looks at the string, because they arrive
 * *ahead of the minus*: `MINUS_SIGN` is anchored, so a pasted `\u061c-1234`
 * reads as positive and the figure silently changes sign. `formatCurrency`
 * and `formatNumber` go straight through `Intl`, so this is a figure the app
 * itself prints — which is exactly the round-trip the note above promises.
 */
const BIDI_MARKS = /[\u061c\u200e\u200f]/g;

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

  const stripped = toAsciiFigures(raw).replace(GROUPING_ONLY, '');
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
  //
  // Only where the reading is genuinely two-way — see `couldBeGrouping`.
  const ambiguous =
    (typedFraction !== null &&
      typedFraction.length === 3 &&
      /^[1-9]\d{0,2}$/.test(whole) &&
      couldBeGrouping(separator)) ||
    // An integer field that was handed a decimal point: the fraction is going
    // to be dropped, and the reader has to be told which number survived.
    // Nothing to do with separators, so nothing to do with the locale.
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

/**
 * Could the reader have meant this separator as grouping (SC-417)?
 *
 * The residual ambiguity in the header — `1,234` as a thousand or as
 * one-point-two-three-four — is not a property of the character. It is a
 * property of the character *in the locale the app formats in*: a separator can
 * have been grouping only where that locale groups with it.
 *
 * Measured in Bun 1.3.14 across every row of `LANGUAGE_FORMATS`. `en`, `ja` and
 * `zh` group with `,`; `es`, `id` (and `en-DE`, `pt-BR`) group with `.`; `fr`
 * groups with U+202F, `pt` and `ru` with U+00A0, `ar` with U+066C. So a comma
 * is a live doubt in English and none at all in Spanish, where a comma is the
 * decimal point and `1.234` is the thousand — and in Russian neither character
 * groups, which is the reported defect: the notice announced a doubt about
 * input Russian makes unambiguous, on a field that had read it correctly.
 *
 * The space-grouping locales are not a new case, only a newly-honest one.
 * `GROUPING_ONLY` has stripped their separator before it could be read as
 * anything since SC-75, so `1 234` has always parsed to a thousand with no
 * flag. This is that same reasoning applied to the character the reader typed.
 *
 * **The parse stays locale-blind on purpose.** Both separators are the decimal
 * point for everyone (SC-75) because the reader's keyboard is not the reader's
 * locale, and nothing here changes which number comes out. This decides only
 * whether to say the number could have been another one.
 */
function couldBeGrouping(separator: string): boolean {
  return (
    separator !== '' && separator === figuresFor(getFormatLocale().numberLocale).groupCharacter
  );
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
 * The canonical rendering of a submitted value, **in the locale the app prints
 * every other figure in** (`getFormatLocale().numberLocale`).
 *
 * Shown whenever the field is not being edited, so the reader is always told
 * which number was understood — `12,99` typed comes back as `12.99` in English
 * and `12,99` in Russian, and a `1,234` that was meant as a thousand comes back
 * as `1.234` / `1,234`, where the reader can see it rather than discover it in
 * the portfolio total a week later.
 *
 * **This used to be pinned to `en-US`, and the pin was correct when it was
 * written** (SC-75): every figure the app printed was `en-US`, so the echo
 * agreed with the screen around it. SC-201 made the printed figures follow the
 * interface language and left the echo behind, so an APY sheet in Russian read
 * `4,5` back as `4.5` beside «примерно 450,00 EUR», and `1234.5` back as
 * `1,234.5` — one-point-two-three-four-five to the reader — beside `1 234,5`
 * everywhere else (SC-415).
 *
 * The disambiguation the echo exists for survives the move, and it is checked
 * per language rather than assumed: `amount-input.test.ts` asserts that in
 * every row of `LANGUAGE_FORMATS`, `1.234` and `1234` still render
 * differently. They do, because no CLDR locale uses one character for both
 * jobs.
 *
 * The fraction is echoed **verbatim** rather than re-rounded, so a deliberate
 * `12.30` does not come back as `12.3` — which is why this builds the string
 * rather than handing the value to `formatNumber`, whose `Number` round-trip
 * both rounds and, past 15 significant digits, loses digits a token balance
 * has.
 */
export function formatAmountForDisplay(value: string, suffix = ''): string {
  if (value.trim() === '') return '';
  const canonical = CANONICAL_VALUE.exec(value);
  // Contract says `-?\d+(\.\d+)?`; anything else is shown as it arrived
  // rather than mangled into a number it is not.
  if (!canonical) return `${value}${suffix}`;

  const [, sign = '', whole = '0', fraction] = canonical;
  const figures = figuresFor(getFormatLocale().numberLocale);
  const magnitude =
    figures.group(BigInt(whole)) +
    (fraction === undefined ? '' : figures.decimal + localizeDigits(fraction, figures));

  return `${sign === '-' ? MINUS : ''}${magnitude}${suffix}`;
}

/**
 * The same figure, spelled in ASCII (SC-416).
 *
 * `formatAmountForDisplay` follows `getFormatLocale().numberLocale` since
 * SC-415, and for `ar-EG` that means Arabic-Indic digits: it printed
 * `\u0661\u066c\u0662\u0663\u0664\u066b\u0665\u0666` for 1234.56 while the
 * parser stripped everything outside `[0-9.,]` — so the field could not read
 * what the field had just written, and a paste became the empty value with
 * nothing said. That breaks the round-trip `MINUS_SIGN` above exists for.
 *
 * Scoped to the locale the app is formatting in rather than to every numbering
 * system, because that is the scope of the promise: the app prints in one
 * locale, so reading that one back is what makes a copy-paste survive.
 *
 * **A locale whose digits and decimal point are already ASCII takes no path
 * through here beyond the bidi strip**, so every existing language — every
 * one that has a locale file — parses byte-for-byte as before.
 *
 * **Known limitation, for whoever lands the `ar` locale file.** The digits are
 * converted on the way *in*, so while the field is focused a reader typing on
 * an Arabic keypad watches their digits turn ASCII; the blurred echo is
 * Arabic-Indic again. Acceptable while no reader can select `ar` — the row
 * exists in `LANGUAGE_FORMATS` but `supportedLngs` is computed from the locale
 * directory — and it is the half of the field an Arabic locale has to look at
 * anyway, alongside the RTL work `LANGUAGE_FORMATS` is explicit about not
 * having done.
 */
function toAsciiFigures(raw: string): string {
  const plain = raw.replace(BIDI_MARKS, '');
  const figures = figuresFor(getFormatLocale().numberLocale);
  if (figures.ascii) return plain;

  let out = '';
  for (const character of plain) {
    const digit = figures.digits.indexOf(character);
    if (digit !== -1) {
      out += String(digit);
    } else if (character === figures.decimal) {
      out += '.';
    } else if (character !== figures.groupCharacter) {
      // Anything else is passed through for the `[^0-9.,]` strip to judge.
      // The group character is dropped: unlike `,` and `.` it has no second
      // reading, so there is nothing for `findDecimalSeparator` to weigh.
      out += character;
    }
  }
  return out;
}

/** U+2212, matching `<Numeric>` — `Intl` emits an ASCII hyphen for most
 *  locales, which is narrower than a digit and breaks a ledger column. */
const MINUS = '\u2212';

const CANONICAL_VALUE = /^(-?)(\d+)(?:\.(\d+))?$/;

interface LocaleFigures {
  /** Grouped whole part. `BigInt` because a token balance can carry more
   *  significant digits than a `number` holds, and because grouping is not
   *  every-three everywhere — `en-IN` groups `1234567` as `12,34,567`. */
  readonly group: (whole: bigint) => string;
  readonly decimal: string;
  /** What separates the groups, or `''` where the locale does not group.
   *  `,` in `en`, `.` in `es`, U+00A0 in `ru`, U+066C in `ar-EG`. */
  readonly groupCharacter: string;
  /** The locale's own digits, indexed by the ASCII digit they replace.
   *  `ar-EG` prints `4` as `٤`, and a fraction spelled in ASCII beside a
   *  whole part spelled in Arabic-Indic is the mixed reading this fixes. */
  readonly digits: readonly string[];
  /** Nothing to convert on the way in: the digits and the decimal point are
   *  already the characters the parser reads. True for every locale with a
   *  file today, which is why they all take the fast path. */
  readonly ascii: boolean;
}

const FIGURES = new Map<string, LocaleFigures>();

function figuresFor(locale: string): LocaleFigures {
  const cached = FIGURES.get(locale);
  if (cached) return cached;

  const grouping = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const decimal =
    new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === 'decimal')
      ?.value ?? '.';
  // Seven figures, so a locale that only groups above four digits still emits
  // the part. `''` for a locale that does not group at all.
  const groupCharacter =
    new Intl.NumberFormat(locale).formatToParts(1234567).find((part) => part.type === 'group')
      ?.value ?? '';
  // `1234567890` ungrouped, so each digit lands at its own index and `0`
  // arrives last. Spread by code point, not `split('')`.
  const spelled = [...new Intl.NumberFormat(locale, { useGrouping: false }).format(1234567890n)];
  const digits = [spelled[9] ?? '0', ...spelled.slice(0, 9)];
  const figures: LocaleFigures = {
    group: (whole) => grouping.format(whole),
    decimal,
    groupCharacter,
    digits,
    ascii: digits.every((digit, index) => digit === String(index)) && /^[.,]$/.test(decimal),
  };
  FIGURES.set(locale, figures);
  return figures;
}

function localizeDigits(source: string, figures: LocaleFigures): string {
  return source.replace(/\d/g, (digit) => figures.digits[Number(digit)] ?? digit);
}
