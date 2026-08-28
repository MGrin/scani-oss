import { describe, expect, test } from 'bun:test';
import { EMAIL_STRINGS, type EmailStrings, fill, resolveEmailStrings } from '../../src/i18n';
import { renderMagicLinkEmail } from '../../src/templates/magic-link';
import { renderOtpEmail } from '../../src/templates/otp';
import { renderVerificationEmail } from '../../src/templates/verification';
import { SCANI_BRAND } from '../../src/types';

/** Every leaf string in a bundle, with its dotted path. */
function leaves(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

describe('resolving a language', () => {
  test('a language we can write in gets its own bundle', () => {
    expect(resolveEmailStrings('ru')).toBe(EMAIL_STRINGS.ru as EmailStrings);
    expect(resolveEmailStrings('en')).toBe(EMAIL_STRINGS.en as EmailStrings);
  });

  test('a region, a case, an underscore — all still the language', () => {
    // The value arrives on a header written by a client. Being strict about
    // its spelling buys nothing and costs a Russian reader their letter.
    for (const tag of ['ru-RU', 'RU', 'ru_RU', 'Ru-latn-ru']) {
      expect(resolveEmailStrings(tag)).toBe(EMAIL_STRINGS.ru as EmailStrings);
    }
  });

  test('a language we cannot write in falls back to English', () => {
    for (const tag of ['de', 'ja-JP', 'zzz', '', '   ', null, undefined]) {
      expect(resolveEmailStrings(tag)).toBe(EMAIL_STRINGS.en as EmailStrings);
    }
  });
});

describe('the fallback is the WHOLE letter, never a key of it', () => {
  /**
   * The property SC-412's third decision is about (and SC-409 before it).
   *
   * A screen may show one English label among Russian ones — a blemish. A
   * LETTER that does it says one paragraph in Russian and the sentence
   * explaining it in English, in the first message an account ever receives.
   * The type makes a partial bundle uncompilable; this makes a template that
   * hard-codes one sentence fail out loud.
   */
  const distinctive = leaves(EMAIL_STRINGS.en)
    .filter(([path]) => path !== 'lang')
    // Short strings ("Code: {code}") share too many words with a URL or a
    // brand name to be evidence of anything.
    .filter(([, value]) => value.replace(/\{\w+\}/g, '').trim().length > 24)
    .map(([, value]) => value.split('{')[0]?.trim() ?? value)
    .filter((fragment) => fragment.length > 24);

  test('there is something to check', () => {
    expect(distinctive.length).toBeGreaterThan(8);
  });

  /**
   * Every language we have a bundle for, not a list somebody remembers to
   * extend. The hard-coded `ru` array this replaces was the whole population
   * of the two checks below, so a French bundle added beside it shipped with
   * nothing asserting it was French or free of English (SC-761).
   */
  const everyLetter = (language: string) => [
    renderMagicLinkEmail({ brand: SCANI_BRAND, url: 'https://app.scani.xyz/x', language }),
    renderVerificationEmail({ brand: SCANI_BRAND, url: 'https://app.scani.xyz/x', language }),
    renderOtpEmail({ brand: SCANI_BRAND, code: '123456', type: 'sign-in', language }),
    renderOtpEmail({ brand: SCANI_BRAND, code: '123456', type: 'change-email', language }),
  ];

  const english = everyLetter('en');
  const translated = Object.keys(EMAIL_STRINGS)
    .filter((code) => code !== 'en')
    .map((code) => ({ code, letters: everyLetter(code) }));

  test('there is a translated language to check at all', () => {
    // Without this the two assertions below pass over an empty list, which is
    // what a filter narrowing to nothing looks like from the outside.
    expect(translated.map((l) => l.code)).not.toEqual([]);
  });

  test('no English sentence survives into a translated letter', () => {
    for (const { code, letters } of translated) {
      for (const letter of letters) {
        const whole = `${letter.subject}\n${letter.text}\n${letter.html}`;
        const leaked = distinctive.filter((fragment) => whole.includes(fragment));
        expect([code, leaked]).toEqual([code, []]);
      }
    }
  });

  test('a translated letter declares its own language, subject included', () => {
    // The other direction: a template that routed everything through the
    // bundle but resolved `en` would pass the assertion above trivially.
    // `lang` is what works for every script; a Latin-script language has no
    // character class to test the way Cyrillic does. The subject is compared
    // against ITS OWN English counterpart, not against one fixed subject —
    // four different letters differ from any single subject for free.
    for (const { code, letters } of translated) {
      letters.forEach((letter, i) => {
        expect([code, i, letter.html.includes(`<html lang="${code}">`)]).toEqual([code, i, true]);
        expect([
          code,
          i,
          letter.subject === (english[i] as (typeof letters)[number]).subject,
        ]).toEqual([code, i, false]);
      });
    }
  });

  test('the Russian letter is in Cyrillic', () => {
    // Kept language-specific on purpose: it is the one assertion above that
    // a script gives you for free, and dropping it to generalise would trade
    // a real check for a uniform one.
    const russian = translated.find((l) => l.code === 'ru');
    expect(russian?.code).toBe('ru');
    for (const letter of russian?.letters ?? []) {
      expect(letter.subject).toMatch(/\p{Script=Cyrillic}/u);
      expect(letter.text).toMatch(/\p{Script=Cyrillic}/u);
    }
  });

  test('English is still English', () => {
    const letter = renderMagicLinkEmail({ brand: SCANI_BRAND, url: 'https://x', language: 'en' });
    expect(letter.subject).toBe('Sign in to Scani');
    expect(letter.html).toContain('<html lang="en">');
    // …and an unknown language gets exactly that letter, byte for byte.
    expect(renderMagicLinkEmail({ brand: SCANI_BRAND, url: 'https://x', language: 'de' })).toEqual(
      letter
    );
    expect(renderMagicLinkEmail({ brand: SCANI_BRAND, url: 'https://x' })).toEqual(letter);
  });
});

describe('the bundles agree on what a letter is made of', () => {
  test('every locale answers every key English does', () => {
    // Redundant with the type today and deliberately kept: the day these
    // become JSON — which is what a translator wants — the type stops being
    // the guard and this is what is left.
    const expected = leaves(EMAIL_STRINGS.en)
      .map(([path]) => path)
      .sort();
    for (const [code, bundle] of Object.entries(EMAIL_STRINGS)) {
      expect([
        code,
        leaves(bundle)
          .map(([path]) => path)
          .sort(),
      ]).toEqual([code, expected]);
    }
  });

  test('a bundle names its own language', () => {
    for (const [code, bundle] of Object.entries(EMAIL_STRINGS)) {
      expect(bundle.lang).toBe(code);
    }
  });

  test('no locale invents a placeholder the English string does not have', () => {
    // `fill` leaves an unknown placeholder standing rather than blanking it,
    // so a stray `{name}` ships as literal `{name}` in a subject line.
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();
    const english = new Map(leaves(EMAIL_STRINGS.en).map(([path, value]) => [path, value]));
    for (const [code, bundle] of Object.entries(EMAIL_STRINGS)) {
      for (const [path, value] of leaves(bundle)) {
        const allowed = placeholders(english.get(path) ?? '');
        for (const found of placeholders(value)) {
          expect([code, path, found, allowed.includes(found)]).toEqual([code, path, found, true]);
        }
      }
    }
  });
});

describe('fill', () => {
  test('substitutes what it knows and leaves what it does not', () => {
    expect(fill('Sign in to {app}', { app: 'Scani' })).toBe('Sign in to Scani');
    // Visible bug report beats a silent gap where the code should be.
    expect(fill('{code} — code', {})).toBe('{code} — code');
  });
});
