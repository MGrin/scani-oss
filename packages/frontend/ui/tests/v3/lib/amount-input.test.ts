import { afterEach, describe, expect, it } from 'bun:test';
import { LANGUAGE_FORMATS, resetFormatLocale, setFormatLocale } from '@scani/shared';

import { formatAmountForDisplay, parseAmountInput } from '../../../src/v3/lib/amount-input';

afterEach(resetFormatLocale);

/** Replays a field being typed into one key at a time, the way SC-75 was
 *  found: every intermediate state is asserted, not just the last one. */
function type(keys: string, rules?: Parameters<typeof parseAmountInput>[1]) {
  let text = '';
  const states: { text: string; value: string }[] = [];
  for (const key of keys) {
    const parsed = parseAmountInput(text + key, rules);
    text = parsed.text;
    states.push({ text: parsed.text, value: parsed.value });
  }
  return states;
}

describe('parseAmountInput — the SC-75 regression', () => {
  it('does not swallow a decimal comma into a hundredfold error', () => {
    // The exact keystrokes from the ticket. The old field showed "1,299".
    const states = type('12,99');
    expect(states.map((s) => s.text)).toEqual(['1', '12', '12,', '12,9', '12,99']);
    expect(states.at(-1)?.value).toBe('12.99');
  });

  it('reads 1,5 as one and a half, not fifteen', () => {
    expect(parseAmountInput('1,5', { decimalScale: 8 }).value).toBe('1.5');
  });

  it('still reads a decimal point', () => {
    expect(parseAmountInput('12.99').value).toBe('12.99');
  });

  it('keeps the separator the reader typed on screen', () => {
    expect(parseAmountInput('12,99').text).toBe('12,99');
    expect(parseAmountInput('12.99').text).toBe('12.99');
  });

  it('never changes magnitude across a keystroke that is rejected', () => {
    // A second separator, a letter, a stray currency symbol.
    expect(parseAmountInput('12,99,', { decimalScale: 2 }).value).toBe('12.99');
    expect(parseAmountInput('12,99x').value).toBe('12.99');
    expect(parseAmountInput('$12,99').value).toBe('12.99');
  });
});

describe('parseAmountInput — paste from a statement', () => {
  it('reads European grouping', () => {
    expect(parseAmountInput('1 234,56').value).toBe('1234.56');
    expect(parseAmountInput('1.234,56').value).toBe('1234.56');
    expect(parseAmountInput('1 234,56').value).toBe('1234.56');
    expect(parseAmountInput("1'234,56").value).toBe('1234.56');
  });

  it('reads US grouping', () => {
    expect(parseAmountInput('1,234.56').value).toBe('1234.56');
    expect(parseAmountInput('1,234,567.89').value).toBe('1234567.89');
  });

  it('reads a repeated separator as grouping, never as a decimal point', () => {
    expect(parseAmountInput('1,234,567', { decimalScale: 2 }).value).toBe('1234567');
    expect(parseAmountInput('1.234.567', { decimalScale: 2 }).value).toBe('1234567');
  });

  it('round-trips a figure copied out of the app', () => {
    expect(parseAmountInput('−1,234.56', { allowNegative: true }).value).toBe('-1234.56');
  });
});

describe('parseAmountInput — the one genuine ambiguity', () => {
  it('flags a lone separator with three digits behind it in a money field', () => {
    const parsed = parseAmountInput('1,234', { decimalScale: 2 });
    expect(parsed.ambiguous).toBe(true);
    expect(parsed.value).toBe('1.23');
  });

  it('flags it in a field that can hold three decimals too, and keeps them', () => {
    const parsed = parseAmountInput('1,234', { decimalScale: 8 });
    expect(parsed.ambiguous).toBe(true);
    expect(parsed.value).toBe('1.234');
  });

  it('does not flag a shape that cannot be grouping', () => {
    // A leading zero and a four-digit head are both impossible first groups.
    expect(parseAmountInput('0,123', { decimalScale: 8 }).ambiguous).toBe(false);
    expect(parseAmountInput('1234,567', { decimalScale: 8 }).ambiguous).toBe(false);
  });

  it('does not flag when the other separator resolves it', () => {
    expect(parseAmountInput('1,234.56').ambiguous).toBe(false);
    expect(parseAmountInput('1,234,567', { decimalScale: 2 }).ambiguous).toBe(false);
  });
});

/**
 * SC-417 — the grouping character of every row in `LANGUAGE_FORMATS`, measured
 * in Bun 1.3.14. One of the two the field reads as a decimal point means a
 * separator typed there really can be two numbers; anything else means it
 * cannot.
 *
 * Written out rather than derived from `Intl` on the spot. Deriving it would
 * restate the implementation and pass against whatever CLDR happens to say;
 * this fails when CLDR moves a language across the line, which is the moment a
 * person has to look at it.
 */
const GROUPS_WITH: Readonly<Record<string, string>> = {
  en: ',',
  ar: '\u066c',
  es: '.',
  fr: '\u202f',
  id: '.',
  ja: ',',
  pt: '\u00a0',
  ru: '\u00a0',
  zh: ',',
};

describe('parseAmountInput — the ambiguity is a fact about the separator (SC-417)', () => {
  it('covers every language the app can format in', () => {
    expect(Object.keys(GROUPS_WITH).sort()).toEqual(Object.keys(LANGUAGE_FORMATS).sort());
  });

  it('says nothing to a Russian reader, whose thousand is a space', () => {
    setFormatLocale('ru');
    const parsed = parseAmountInput('1,234', { decimalScale: 8 });
    // The reading is unchanged — only the doubt about it is gone.
    expect(parsed.value).toBe('1.234');
    expect(parsed.ambiguous).toBe(false);
    // Nor about the other character: Russian groups with neither.
    expect(parseAmountInput('1.234', { decimalScale: 8 }).ambiguous).toBe(false);
  });

  it('still says it in English, where a comma really is two-way', () => {
    setFormatLocale('en');
    expect(parseAmountInput('1,234', { decimalScale: 8 }).ambiguous).toBe(true);
    // …and not about the full stop, which is English's decimal point.
    expect(parseAmountInput('1.234', { decimalScale: 8 }).ambiguous).toBe(false);
  });

  it('swaps the two characters over for a language that groups the other way', () => {
    // Spanish: `1,234` is one-point-two-three-four and nothing else; the
    // thousand a Spanish reader could have meant is `1.234`.
    setFormatLocale('es');
    expect(parseAmountInput('1,234', { decimalScale: 8 }).ambiguous).toBe(false);
    expect(parseAmountInput('1.234', { decimalScale: 8 }).ambiguous).toBe(true);
  });

  it('follows an explicit region rather than the language', () => {
    // English words, European figures — so the doubt moves to the full stop.
    setFormatLocale('en', 'DE');
    expect(parseAmountInput('1,234', { decimalScale: 8 }).ambiguous).toBe(false);
    expect(parseAmountInput('1.234', { decimalScale: 8 }).ambiguous).toBe(true);
  });

  it('flags exactly the character each language groups with, and no other', () => {
    for (const [language, group] of Object.entries(GROUPS_WITH)) {
      setFormatLocale(language);
      for (const separator of [',', '.']) {
        const parsed = parseAmountInput(`1${separator}234`, { decimalScale: 8 });
        expect({ language, separator, ambiguous: parsed.ambiguous }).toEqual({
          language,
          separator,
          ambiguous: separator === group,
        });
        // Whichever way it is read aloud, it is read as the same number.
        expect(parsed.value).toBe('1.234');
      }
    }
  });

  it('keeps the dropped-fraction notice, which is not about separators', () => {
    // An integer field in Russian still has to say which number survived —
    // that warning is about the scale, and the scale has no locale.
    setFormatLocale('ru');
    const settled = parseAmountInput('12,99', { decimalScale: 0 });
    expect(settled.value).toBe('12');
    expect(settled.ambiguous).toBe(true);
  });
});

describe('parseAmountInput — scale and sign', () => {
  it('truncates past the scale rather than rounding the reader up', () => {
    expect(parseAmountInput('12.999', { decimalScale: 2 }).value).toBe('12.99');
  });

  it('truncates the value but never the text', () => {
    // Typing `1,234.56` into a money field: the comma only turns out to be
    // grouping when the `.` arrives four keystrokes later, so the digits in
    // between have to survive on screen or the field stalls at 1.23.
    const states = type('1,234.56', { decimalScale: 2 });
    expect(states.map((s) => s.text)).toEqual([
      '1',
      '1,',
      '1,2',
      '1,23',
      '1,234',
      '1234.',
      '1234.5',
      '1234.56',
    ]);
    expect(states.at(-1)?.value).toBe('1234.56');
  });

  it('reads a well-formed group in an integer field as a thousand', () => {
    const parsed = parseAmountInput('1,234', { decimalScale: 0 });
    expect(parsed.value).toBe('1234');
    expect(parsed.ambiguous).toBe(false);
    expect(parseAmountInput('12', { decimalScale: 0 }).ambiguous).toBe(false);
  });

  it('keeps a dropped fraction on screen in an integer field, and says so', () => {
    // The regression this file exists for, in the field that has no decimals:
    // dropping the separator outright let the next digit close the gap and
    // turned 12,99 into 1299. The fraction stays visible instead.
    const states = type('12,99', { decimalScale: 0 });
    expect(states.map((s) => s.text)).toEqual(['1', '12', '12,', '12,9', '12,99']);
    const settled = parseAmountInput('12,99', { decimalScale: 0 });
    expect(settled.value).toBe('12');
    expect(settled.ambiguous).toBe(true);
  });

  it('holds a lone separator on screen instead of deleting the keystroke', () => {
    expect(parseAmountInput(',')).toEqual({ text: ',', value: '', ambiguous: false });
  });

  it('reads a leading separator as a leading zero', () => {
    expect(parseAmountInput(',5', { decimalScale: 8 }).value).toBe('0.5');
  });

  it('drops a minus unless the field allows one', () => {
    expect(parseAmountInput('-5').value).toBe('5');
    expect(parseAmountInput('-5', { allowNegative: true }).value).toBe('-5');
  });

  it('preserves a trailing zero the reader typed on purpose', () => {
    expect(parseAmountInput('12.30').value).toBe('12.30');
  });

  it('is empty for empty input', () => {
    expect(parseAmountInput('').value).toBe('');
    expect(parseAmountInput('   ').value).toBe('');
  });
});

describe('formatAmountForDisplay — English, unchanged', () => {
  it('groups in en-US with no language chosen', () => {
    expect(formatAmountForDisplay('1234567.89')).toBe('1,234,567.89');
    expect(formatAmountForDisplay('12.99')).toBe('12.99');
    expect(formatAmountForDisplay('1000')).toBe('1,000');
  });

  it('is the same under en-GB, which shares both separators', () => {
    setFormatLocale('en', 'GB');
    expect(formatAmountForDisplay('1234567.89')).toBe('1,234,567.89');
    expect(formatAmountForDisplay('1000')).toBe('1,000');
    expect(formatAmountForDisplay('-1234')).toBe('\u22121,234');
  });

  it('echoes the fraction verbatim rather than re-rounding it', () => {
    expect(formatAmountForDisplay('12.30')).toBe('12.30');
    expect(formatAmountForDisplay('0.00000001')).toBe('0.00000001');
  });

  it('keeps digits a number would lose past 15 significant figures', () => {
    // A token balance, which is why the whole part goes through `BigInt`.
    expect(formatAmountForDisplay('1234567890.12345678')).toBe('1,234,567,890.12345678');
  });

  it('appends a suffix and uses the same minus as <Numeric>', () => {
    expect(formatAmountForDisplay('12.5', '%')).toBe('12.5%');
    expect(formatAmountForDisplay('-1234')).toBe('\u22121,234');
  });

  it('is empty for no value, and passes a non-canonical value through', () => {
    expect(formatAmountForDisplay('')).toBe('');
    expect(formatAmountForDisplay('1e-8')).toBe('1e-8');
  });
});

describe('formatAmountForDisplay — the SC-415 defect', () => {
  it('reads a Russian amount back in Russian', () => {
    setFormatLocale('ru');
    // The APY sheet from the ticket: typed `4,5`, blurred to `4.5`.
    expect(formatAmountForDisplay('4.5')).toBe('4,5');
    // And the one that inverted the value's meaning: `1,234.5` read as 1.2345.
    expect(formatAmountForDisplay('1234.5')).toBe('1\u00a0234,5');
    expect(formatAmountForDisplay('1234567.89')).toBe('1\u00a0234\u00a0567,89');
    expect(formatAmountForDisplay('12.5', '%')).toBe('12,5%');
  });

  it('groups with a dot where the language does', () => {
    // English words, European figures — one BCP-47 tag (SC-201).
    setFormatLocale('en', 'DE');
    expect(formatAmountForDisplay('1234567.89')).toBe('1.234.567,89');
    expect(formatAmountForDisplay('4.5')).toBe('4,5');
  });

  it('spells the fraction in the same digits as the whole part', () => {
    // `ar` has no locale file yet, so no reader can reach this — but a mixed
    // reading (Arabic-Indic thousands, ASCII cents) is what a fraction
    // appended by hand would produce, so it is pinned before it can ship.
    setFormatLocale('ar');
    expect(formatAmountForDisplay('1234.56')).toBe(
      '\u0661\u066c\u0662\u0663\u0664\u066b\u0665\u0666'
    );
  });
});

describe('formatAmountForDisplay — the echo still disambiguates', () => {
  // The question SC-415 refused to answer by assumption: following the locale
  // is only safe if `1.234` and `1234` stay distinguishable in every language
  // the app offers, since telling them apart is the whole job of the echo.
  for (const language of Object.keys(LANGUAGE_FORMATS)) {
    it(`tells 1.234 from 1234 in ${language}`, () => {
      setFormatLocale(language);
      const decimal = formatAmountForDisplay('1.234');
      const thousand = formatAmountForDisplay('1234');
      expect(decimal).not.toBe(thousand);
    });
  }
});

describe('parseAmountInput — reads back what the field printed (SC-416)', () => {
  it('reads the Arabic-Indic figure the app itself writes', () => {
    setFormatLocale('ar');
    // The exact string from the ticket, measured in Bun 1.3.14:
    // Intl.NumberFormat('ar-EG').format(1234.56) -> ١٬٢٣٤٫٥٦
    const printed = formatAmountForDisplay('1234.56');
    expect(printed).toBe('\u0661\u066c\u0662\u0663\u0664\u066b\u0665\u0666');
    // Before: the `[^0-9.,]` strip left nothing and the field went empty in
    // silence, on the value it had just displayed.
    expect(parseAmountInput(printed, { decimalScale: 8 }).value).toBe('1234.56');
  });

  it('keeps the sign through the invisible mark Intl puts in front of it', () => {
    // `formatCurrency` and `formatNumber` go straight through `Intl`, which
    // writes U+061C before the hyphen in ar-EG. `MINUS_SIGN` is anchored, so
    // that mark used to read as "no minus here" — a sign error rather than an
    // empty field, and the worse of the two failures.
    setFormatLocale('ar');
    const printed = new Intl.NumberFormat('ar-EG').format(-1234);
    expect(printed.codePointAt(0)).toBe(0x061c);
    expect(parseAmountInput(printed, { allowNegative: true, decimalScale: 8 }).value).toBe('-1234');
  });

  it('strips the bidi mark whatever language is selected', () => {
    // Nothing about it is Arabic-specific: an anchored regex cannot see past
    // an invisible character in any locale.
    setFormatLocale('en');
    expect(parseAmountInput('\u200e-1234', { allowNegative: true }).value).toBe('-1234');
  });

  it('round-trips its own display in every language the app can format in', () => {
    for (const language of Object.keys(LANGUAGE_FORMATS)) {
      setFormatLocale(language);
      for (const value of ['1234.56', '1234567.89', '0.00000001', '12.30']) {
        const printed = formatAmountForDisplay(value);
        expect({
          language,
          value,
          read: parseAmountInput(printed, { decimalScale: 8 }).value,
        }).toEqual({ language, value, read: value });
      }
    }
  });

  it('leaves a locale that already spells figures in ASCII exactly as it was', () => {
    // The fast path. Russian groups with U+00A0 and decimals with `,`, both of
    // which the parser has always handled — nothing here may touch them.
    setFormatLocale('ru');
    expect(parseAmountInput('1\u00a0234,56').value).toBe('1234.56');
    expect(parseAmountInput('12,99').text).toBe('12,99');
    setFormatLocale('en');
    expect(parseAmountInput('1,234.56').value).toBe('1234.56');
    expect(parseAmountInput('12.99').text).toBe('12.99');
  });
});

describe('round trip', () => {
  it('re-reads its own display without drift', () => {
    for (const value of ['1234567.89', '12.99', '0.00000001', '1000.00', '1234.5']) {
      expect(parseAmountInput(formatAmountForDisplay(value), { decimalScale: 8 }).value).toBe(
        value
      );
    }
  });

  it('flags the one English display that cannot round-trip', () => {
    // "1,000" with no decimals is the ambiguity in its purest form: three
    // digits behind a lone separator. It reads as 1.000 and says so.
    const parsed = parseAmountInput(formatAmountForDisplay('1000'), { decimalScale: 8 });
    expect(parsed.value).toBe('1.000');
    expect(parsed.ambiguous).toBe(true);
  });

  it('has nothing to flag in a language that groups with a space', () => {
    // The same value, echoed in Russian, is unambiguous on the way back in:
    // `1 000` strips to a thousand by the grouping rule that already existed.
    setFormatLocale('ru');
    const parsed = parseAmountInput(formatAmountForDisplay('1000'), { decimalScale: 8 });
    expect(parsed.value).toBe('1000');
    expect(parsed.ambiguous).toBe(false);
  });
});
