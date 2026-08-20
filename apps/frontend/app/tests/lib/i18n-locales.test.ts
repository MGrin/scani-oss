import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LANGUAGE_FORMATS } from '@scani/shared';

/**
 * The locale split, checked rather than remembered (SC-169).
 *
 * Every locale is two files: `src/i18n/locales/<code>.json` ships in the entry
 * chunk, `src/v3/i18n/locales/<code>.json` ships with v3. The split exists so a
 * visitor who never signs in does not download 1062 v3 strings, and it is worth
 * 12.9 KB brotli off the one download every cold visit waits for.
 *
 * Three ways it can rot, and all three are silent:
 *
 * 1. **A `v3.*` key drifts back into the shell file.** The build still works —
 *    the key resolves, nothing renders wrong — and the 12.9 KB comes back.
 * 2. **A locale exists on one side only.** `supportedLngs` is computed from the
 *    shell directory, so a v3-only locale is never selectable, and a shell-only
 *    locale renders raw `v3.*` keys across the whole interface.
 * 3. **A key is defined on both sides.** `addResourceBundle` is called with
 *    `overwrite: false`, so the v3 file would lose silently — two spellings of
 *    one string, and the one you edit is not the one that shows.
 */

const SHELL = resolve(import.meta.dir, '../../src/i18n/locales');
const V3 = resolve(import.meta.dir, '../../src/v3/i18n/locales');

function codes(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

function load(dir: string, code: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, `${code}.json`), 'utf8')) as Record<string, unknown>;
}

/** Every leaf path in an object, dot-joined. */
function paths(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null) return [prefix];
  return Object.entries(node).flatMap(([k, v]) => paths(v, prefix ? `${prefix}.${k}` : k));
}

/** What a reader of `code` actually gets: both halves of the split, merged. */
function merged(code: string): Record<string, unknown> {
  return { ...load(SHELL, code), ...load(V3, code) };
}

/**
 * The English keys `code` does not answer, named as the keys somebody has to
 * write — so `_one` on an English key becomes `_one`, `_few`, `_many`,
 * `_other` for Russian, and a single `_other` for a language with one form.
 *
 * ONE-DIRECTIONAL, and that is load-bearing (SC-409). `ru` legitimately holds
 * MORE keys than `en` — 1766 against 1560 — because its `ui` branch is a
 * deliberate superset carrying the design system's own strings, which the app's
 * English file does not duplicate. A guard written as `toEqual` fails on
 * correct data, and a guard that fails on correct data gets deleted by the
 * third person who hits it.
 */
function missingAgainstEnglish(code: string): string[] {
  const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
  const have = new Set(paths(merged(code)));
  const missing = new Set<string>();
  for (const key of paths(merged('en'))) {
    // A pluralised English key is satisfied by THIS language's categories, not
    // by English's two — the same rule the kit-key test below already applies.
    const match = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
    if (match?.[1]) {
      for (const category of categories) {
        const form = `${match[1]}_${category}`;
        if (!have.has(form)) missing.add(form);
      }
      continue;
    }
    if (!have.has(key)) missing.add(key);
  }
  return [...missing].sort();
}

/**
 * Locales knowingly allowed to be incomplete, and why.
 *
 * Read rather than imported, so it stays a data file someone edits rather than
 * a module something can compute. The reasoning it encodes is in the file
 * itself; the rules it has to satisfy are the tests at the bottom of this one.
 */
const INCOMPLETE = JSON.parse(
  readFileSync(resolve(import.meta.dir, '../../src/i18n/incomplete-locales.json'), 'utf8')
) as { incomplete: Record<string, string> };

describe('the locale split', () => {
  test('there are locales on both sides at all', () => {
    // A directory that has gone empty would make every assertion below pass
    // while the app renders raw keys.
    expect(codes(SHELL).length).toBeGreaterThan(0);
    expect(codes(V3).length).toBeGreaterThan(0);
  });

  test('every locale exists on both sides', () => {
    expect(codes(V3)).toEqual(codes(SHELL));
  });

  test('the eager half carries no v3 strings', () => {
    for (const code of codes(SHELL)) {
      expect(Object.keys(load(SHELL, code))).not.toContain('v3');
    }
  });

  test('the v3 half carries nothing but v3 strings', () => {
    for (const code of codes(V3)) {
      expect(Object.keys(load(V3, code))).toEqual(['v3']);
    }
  });

  test('no key is defined on both sides', () => {
    for (const code of codes(SHELL)) {
      const shell = new Set(paths(load(SHELL, code)));
      const overlap = paths(load(V3, code)).filter((p) => shell.has(p));
      expect(overlap).toEqual([]);
    }
  });

  test('v3 reaches its strings only through the module that loads them', () => {
    // `V3App` is the one entry into the v3 tree, so the side-effect import has
    // to be there. Anywhere deeper and a route reached another way — a peek, a
    // direct chunk load — renders keys.
    const entry = readFileSync(resolve(import.meta.dir, '../../src/v3/V3App.tsx'), 'utf8');
    expect(entry).toMatch(/^import '\.\/i18n';$/m);
  });

  test('the shell never imports the v3 half', () => {
    // A static import from anywhere outside `src/v3/` puts the JSON back in the
    // entry chunk and undoes the split, with nothing failing but the byte count.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'v3') walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (readFileSync(full, 'utf8').includes('v3/i18n/locales')) {
          offenders.push(full.replace(/.*\/src\//, 'src/'));
        }
      }
    };
    walk(resolve(import.meta.dir, '../../src'));
    expect(offenders).toEqual([]);
  });
});

/**
 * What a new locale file has to satisfy to be a data change (SC-201).
 *
 * The slice this file belongs to claims that adding a language is a JSON file
 * and a row in `LANGUAGE_FORMATS` — no code. That claim is only true if the
 * things code would otherwise have to do are checked here instead, because
 * every one of them fails silently:
 *
 * - **No row in `LANGUAGE_FORMATS`** — dates fall back to `en-GB` under
 *   translated copy, which is SC-175 pointed the other way, and an RTL
 *   language renders left-to-right with no error anywhere.
 * - **No `$meta`** — `AVAILABLE_LANGUAGES` falls back to the bare code, so the
 *   picker offers "ru" rather than "Русский" to the one reader who cannot read
 *   the rest of the list.
 * - **A plural key missing a form the language HAS** — i18next resolves the
 *   missing category to nothing and falls through to English, so a Russian
 *   reader sees Russian at 1 and 21 and English at 2. English cannot catch
 *   this: it has two categories and Russian has four.
 */
describe('a locale file is all it takes', () => {
  test('every locale has a formatting row', () => {
    for (const code of codes(SHELL)) {
      expect(LANGUAGE_FORMATS[code.split('-')[0] ?? code]).toBeDefined();
    }
  });

  test('every locale names itself', () => {
    for (const code of codes(SHELL)) {
      const meta = load(SHELL, code).$meta as { name?: string; nativeName?: string } | undefined;
      expect(meta?.name).toBeTruthy();
      expect(meta?.nativeName).toBeTruthy();
    }
  });

  /**
   * The design system is part of the interface, and `locales/` is the only
   * directory a translator is given (SC-201).
   *
   * `@scani/ui` ships its own `en.json` — 177 keys covering every toast, every
   * error, the export and refine sheets, the theme toggle, "Try again",
   * "Loading…". The app forwards the `ui` branch of each locale file into the
   * package with `addUiLocale`, and the package keeps its English for anything
   * that branch does not carry. Measured when the first real locale was added:
   * the app's `ui` branch and the package's file were **disjoint** — 295 keys
   * against 179, zero overlap. The app defined per-view column and filter
   * labels; the package defined all the chrome, and nothing in `locales/`
   * could reach it.
   *
   * So a fully translated locale still rendered English on every screen, in
   * exactly the strings a reader hits when something goes wrong. Nothing
   * failed, because falling back to English is the designed behaviour for a
   * partial translation — which is what makes this invisible rather than
   * merely broken.
   *
   * English is exempt: the package's own file IS the English, and duplicating
   * it into the app would create the second set of strings nobody remembers to
   * update that `src/i18n/index.ts` argues against.
   */
  test('every non-English locale translates the design system too', () => {
    const kit = JSON.parse(
      readFileSync(
        resolve(import.meta.dir, '../../../../../packages/frontend/ui/src/i18n/locales/en.json'),
        'utf8'
      )
    ) as Record<string, unknown>;
    const required = paths(kit).filter((p) => p.startsWith('ui.'));
    expect(required.length).toBeGreaterThan(0);

    for (const code of codes(SHELL)) {
      // Completeness only — a locale declared incomplete is exempt from this
      // rule and from `missingAgainstEnglish`, and from nothing else (SC-409).
      if (code === 'en' || code in INCOMPLETE.incomplete) continue;
      const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
      const have = new Set(paths(load(SHELL, code)));
      const missing = required.filter((key) => {
        const match = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
        // A pluralised kit key is satisfied by THIS language's categories, not
        // by English's two — `_few` and `_many` are what Russian needs and
        // what the English file cannot name.
        if (match?.[1]) return !categories.every((c) => have.has(`${match[1]}_${c}`));
        return !have.has(key);
      });
      expect(missing).toEqual([]);
    }
  });

  test('every plural key carries every form its language has', () => {
    for (const code of codes(SHELL)) {
      const required = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
      const merged = { ...load(SHELL, code), ...load(V3, code) };
      // A key is pluralised if ANY suffixed form of it exists — `_one` is the
      // one every language has, but a language without a `one` category would
      // legitimately have only `_other`.
      const all = new Set(paths(merged));
      const stems = new Set<string>();
      for (const key of all) {
        const match = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
        if (match?.[1]) stems.add(match[1]);
      }
      const missing: string[] = [];
      for (const stem of stems) {
        for (const category of required) {
          if (!all.has(`${stem}_${category}`)) missing.push(`${code}: ${stem}_${category}`);
        }
      }
      expect(missing).toEqual([]);
    }
  });
});

/**
 * Every English key is answered in every language (SC-409).
 *
 * Russian shipped complete on 2026-08-18 and was **50 keys behind by the same
 * evening** — two PRs' worth, neither author at fault, because there was no
 * guard to fail. Nothing in this file caught it: the tests above check the
 * SPLIT (a locale on both sides, no `v3.*` in the eager half, no key defined
 * twice) and plural-category completeness for keys that already exist. Nothing
 * asserted that an English key HAS a counterpart.
 *
 * It is silent by design, which is the whole problem. English fallback is what
 * i18next is configured to do, so a missing Russian key renders the English
 * sentence: a reader gets English mid-paragraph, no console warning, no visual
 * break, and a reviewer reading English sees nothing wrong. This is the same
 * shape as the `@scani/ui` gap SC-201 found — a locale reported 100% complete
 * that still met English on every error screen.
 *
 * The failure lists every missing key BY NAME. A guard whose output is a number
 * teaches nobody which string to write.
 *
 * **What it does NOT check, stated so nobody infers it.** This asserts a key
 * EXISTS, not that anyone translated it: a `<code>.json` copied wholesale from
 * `en.json` passes every rule here. Comparing VALUES was considered and
 * rejected — legitimately identical values are everywhere, and two are in the
 * very keys this file was written for (`v3.holdings.apy.ratePlaceholder` is
 * `4.5`, which the field parses with `Number()` and would reject as `4,5`; and
 * `dayOfMonthPlaceholder` is `1–31`). A rule that fires on correct data is one
 * the third person to hit it deletes, which is the same argument as the
 * one-directional comparison above.
 *
 * Partial locales are ALLOWED and always have been — `locales/CONTRIBUTORS.md`
 * invites them, and a blanket rule here would have quietly made that document
 * false and failed the first outside translator's PR with no path forward.
 * `incomplete-locales.json` is that path: one deliberate line, in the same PR.
 */
describe('every English key is answered', () => {
  test('there are English keys to answer at all', () => {
    // Non-vacuous: a merge that produced nothing would make the rule below
    // pass by comparing an empty set against everything.
    expect(paths(merged('en')).length).toBeGreaterThan(1000);
  });

  test('the reference locale cannot exempt itself', () => {
    // `en` in the allowlist would silence the comparison rather than a locale.
    expect(Object.keys(INCOMPLETE.incomplete)).not.toContain('en');
  });

  test('no locale is missing a key English defines', () => {
    const missing: string[] = [];
    for (const code of codes(SHELL)) {
      if (code === 'en' || code in INCOMPLETE.incomplete) continue;
      for (const key of missingAgainstEnglish(code)) missing.push(`${code}: ${key}`);
    }
    expect(missing).toEqual([]);
  });

  test('an incomplete locale names itself, exists, and is still incomplete', () => {
    for (const [code, reason] of Object.entries(INCOMPLETE.incomplete)) {
      // A reason, because the next person has to know whether it still holds.
      expect(typeof reason).toBe('string');
      expect(reason.trim().length).toBeGreaterThan(0);
      expect(codes(SHELL)).toContain(code);
      // And it must STILL be incomplete. Without this the exemption outlives
      // the reason for it: a language finishes, nobody removes the line, and
      // the next 50 keys to go missing in it go missing silently — which is
      // the defect this whole block exists to stop, reintroduced by its own
      // escape hatch.
      expect(missingAgainstEnglish(code).length).toBeGreaterThan(0);
    }
  });
});
