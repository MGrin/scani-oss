import { describe, expect, test } from 'bun:test';
import { EMAIL_STRINGS, type EmailStrings, fill, resolveEmailStrings } from '../../src/i18n';
import { escapeHtml } from '../../src/templates/layout';
import { renderMagicLinkEmail } from '../../src/templates/magic-link';
import { renderOtpEmail } from '../../src/templates/otp';
import { renderVerificationEmail } from '../../src/templates/verification';
import { type EmailContent, type OtpType, SCANI_BRAND } from '../../src/types';

/** Every leaf string in a bundle, with its dotted path. */
function leaves(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

/** The one leaf at a dotted path, or `undefined` if the path names nothing. */
function leafAt(bundle: EmailStrings, path: string): string | undefined {
  return leaves(bundle).find(([p]) => p === path)?.[1];
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
    // Every tag here must be absent from EMAIL_STRINGS, so shipping a bundle
    // for one turns this test red rather than weakening it silently. `ja-JP`
    // sat here until Japanese was written, and asserted the opposite of what
    // the app then did.
    for (const tag of ['de', 'ko', 'zzz', '', '   ', null, undefined]) {
      expect(EMAIL_STRINGS[String(tag)]).toBeUndefined();
      expect(resolveEmailStrings(tag)).toBe(EMAIL_STRINGS.en as EmailStrings);
    }
    expect(resolveEmailStrings('ko-KR')).toBe(EMAIL_STRINGS.en as EmailStrings);
  });
});

/**
 * (language, key) pairs whose translation is legitimately the English string.
 *
 * DECLARED, rather than inferred from a length cut, because "short" is not a
 * reason a string is allowed to be English (SC-802). Nothing is in here: of
 * the 148 (language, key) pairs across `es`/`fr`/`pt`/`ru`, zero are
 * byte-identical to English today.
 *
 * The near miss is what says a cut would have been the wrong shape. French's
 * `otp.codeLabel` is `Code : {code}` against English's `Code: {code}` — one
 * narrow no-break space apart, and French typography requires it. A rule keyed
 * on LENGTH admits the whole leaf and then asserts nothing about it; a rule
 * keyed on the LEAF separates the two in the only place they differ.
 *
 * An entry that stops being identical FAILS the run below, so an exemption
 * cannot outlive its reason — the `incomplete-locales.json` shape.
 */
const DECLARED_SHARED_WITH_ENGLISH: ReadonlyArray<readonly [language: string, key: string]> = [];

/**
 * Every `<language>.<key>` whose string a translated bundle repeats verbatim
 * from English, and the size of the population it examined.
 *
 * Key by key over the WHOLE leaf, which is what reaches a subject line, a
 * headline and a button label — the three most visible strings in a letter,
 * and the three a length cut removes first (SC-802).
 *
 * It is silent about a TEMPLATE that hard-codes an English sentence, because a
 * bundle it never reads cannot repeat anything. That is the rendered-letter
 * check further down, and neither arm subsumes the other.
 */
function repeatsEnglish(bundles: Readonly<Record<string, EmailStrings>>): {
  readonly leaked: string[];
  readonly compared: number;
} {
  const english = new Map(leaves(bundles.en as EmailStrings));
  const declared = new Set(DECLARED_SHARED_WITH_ENGLISH.map(([code, path]) => `${code}.${path}`));
  const leaked: string[] = [];
  let compared = 0;
  for (const [code, bundle] of Object.entries(bundles)) {
    if (code === 'en') continue;
    for (const [path, value] of leaves(bundle)) {
      // Not a translation — the bundle's own name, and it is SUPPOSED to differ.
      if (path === 'lang') continue;
      compared += 1;
      if (english.get(path) !== value) continue;
      if (declared.has(`${code}.${path}`)) continue;
      leaked.push(`${code}.${path}`);
    }
  }
  return { leaked, compared };
}

/** `bundles` with exactly one leaf of one language replaced. */
function withLeaf(
  bundles: Readonly<Record<string, EmailStrings>>,
  code: string,
  path: string,
  value: string
): Record<string, EmailStrings> {
  const clone = structuredClone(bundles) as Record<string, EmailStrings>;
  const parts = path.split('.');
  let node = clone[code] as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) node = node[part] as Record<string, unknown>;
  node[parts[parts.length - 1] as string] = value;
  return clone;
}

describe('no translated bundle repeats an English string (SC-802)', () => {
  const englishLeaves = leaves(EMAIL_STRINGS.en).filter(([path]) => path !== 'lang');
  const translated = Object.keys(EMAIL_STRINGS).filter((code) => code !== 'en');

  test('every leaf of every translated bundle was compared', () => {
    // The population, not the verdict. A filter that narrows to nothing and a
    // clean tree read identically from the outside, which is how two length
    // filters put 26 of 37 leaves out of reach with the suite green over it.
    // Derived rather than pinned, so adding a language moves it by itself.
    expect(repeatsEnglish(EMAIL_STRINGS).compared).toBe(translated.length * englishLeaves.length);
  });

  test('no leaf is the English one', () => {
    expect(repeatsEnglish(EMAIL_STRINGS).leaked).toEqual([]);
  });

  test('a declared exemption that is no longer identical is a failure, not a leftover', () => {
    // Empty today. An exemption whose reason has expired would otherwise sit
    // there admitting a leak nobody re-examined.
    const stale = DECLARED_SHARED_WITH_ENGLISH.filter(
      ([code, path]) =>
        leafAt(EMAIL_STRINGS[code] as EmailStrings, path) !==
        leafAt(EMAIL_STRINGS.en as EmailStrings, path)
    );
    expect(stale).toEqual([]);
  });

  test('the check catches a leak at EVERY key, in EVERY language, and names it', () => {
    // The deliverable of SC-802. `no leaf is the English one` passing tells you
    // nothing about which keys it could have spoken up for — the check this
    // replaces was green while blind to every subject line, headline and button
    // label in the bundle. So poison one leaf at a time and require the report
    // to name exactly that one.
    const missed: string[] = [];
    let attempted = 0;
    for (const code of translated) {
      for (const [path, englishValue] of englishLeaves) {
        attempted += 1;
        const poisoned = withLeaf(EMAIL_STRINGS, code, path, englishValue);
        // The mutation arm's own must-be-FOUND. A poisoning that changed
        // nothing leaves the arm reading the baseline, and a baseline green
        // wears the arm's costume.
        if (
          leafAt(poisoned[code] as EmailStrings, path) ===
          leafAt(EMAIL_STRINGS[code] as EmailStrings, path)
        ) {
          missed.push(`${code}.${path} — the mutation did not land`);
          continue;
        }
        // Exactly this leaf and no other: a check that reported everything
        // would satisfy an assertion that only looked for one entry.
        const reported = repeatsEnglish(poisoned).leaked;
        if (reported.length !== 1 || reported[0] !== `${code}.${path}`) {
          missed.push(`${code}.${path} -> ${reported.join(', ') || '(nothing)'}`);
        }
      }
    }
    expect([attempted, missed]).toEqual([translated.length * englishLeaves.length, []]);
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
   *
   * ## Scope, and it is narrower than it looks (SC-802)
   *
   * This arm catches a TEMPLATE hard-coding English: the bundle can be
   * perfectly translated and the letter still come out English. The leaf-by-
   * leaf check above cannot see that, and this one cannot see a short leaked
   * leaf — so the 24-character cut is a SCOPE here, not a coverage threshold.
   * A hard-coded sentence is a sentence.
   *
   * Lowering it was measured rather than argued: at cuts of 24, 12, 4 and 0
   * this arm fires on nothing across `es`/`fr`/`pt`/`ru`, so it would buy no
   * finding — and it would put `Code:` in the population, one narrow no-break
   * space from a false positive against French's `Code : {code}`. Full leaf
   * coverage belongs in the check above, which needs no cut at all.
   */
  const everyLetter = (language: string): EmailContent[] => [
    renderMagicLinkEmail({ brand: SCANI_BRAND, url: 'https://app.scani.xyz/x', language }),
    renderVerificationEmail({ brand: SCANI_BRAND, url: 'https://app.scani.xyz/x', language }),
    // All four purposes, not the two that used to be rendered: a bundle key no
    // letter renders sits in the population unable to fire, which reads exactly
    // like a key that matched nothing (SC-802).
    ...(['sign-in', 'email-verification', 'forget-password', 'change-email'] as OtpType[]).map(
      (type) => renderOtpEmail({ brand: SCANI_BRAND, code: '123456', type, language })
    ),
  ];

  /**
   * Searched against the letter as a reader receives it.
   *
   * The HTML side is compared through the template's own `escapeHtml`, because
   * a raw fragment cannot match escaped markup: `layout.footer` renders ONLY
   * into HTML, where its apostrophe becomes `&#39;`, so it sat in the
   * population unable to fire (SC-802). Going through the production escaper
   * rather than a second copy of the entity table means the two cannot drift.
   */
  const occursIn = (letter: EmailContent, fragment: string): boolean =>
    `${letter.subject}\n${letter.text}`.includes(fragment) ||
    letter.html.includes(escapeHtml(fragment));

  const distinctive = leaves(EMAIL_STRINGS.en)
    .filter(([path]) => path !== 'lang')
    .filter(([, value]) => value.replace(/\{\w+\}/g, '').trim().length > 24)
    .map(([path, value]) => [path, value.split('{')[0]?.trim() ?? value] as const)
    .filter(([, fragment]) => fragment.length > 24);

  const english = everyLetter('en');
  const translated = Object.keys(EMAIL_STRINGS)
    .filter((code) => code !== 'en')
    .map((code) => ({ code, letters: everyLetter(code) }));

  test('every fragment in the population can actually fire', () => {
    // This replaces `distinctive.length > 8`, which passed while three members
    // were inert — `layout.footer` (escaped in the HTML, absent from the text)
    // and the two OTP purposes for `email-verification` / `forget-password`,
    // which no rendered letter carried. A member that CANNOT match reads
    // exactly like one that matched nothing, so the count said nothing (SC-802).
    const inert = distinctive
      .filter(([, fragment]) => !english.some((letter) => occursIn(letter, fragment)))
      .map(([path]) => path);
    expect([distinctive.length > 8, inert]).toEqual([true, []]);
  });

  test('there is a translated language to check at all', () => {
    // Without this the two assertions below pass over an empty list, which is
    // what a filter narrowing to nothing looks like from the outside.
    expect(translated.map((l) => l.code)).not.toEqual([]);
  });

  test('no English sentence survives into a translated letter', () => {
    for (const { code, letters } of translated) {
      for (const letter of letters) {
        const leaked = distinctive
          .filter(([, fragment]) => occursIn(letter, fragment))
          .map(([path]) => path);
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
    // six different letters differ from any single subject for free.
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
