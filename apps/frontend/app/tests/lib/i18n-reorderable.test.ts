import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Whether v3's keys COULD be translated, which is a different question from
 * whether they have been extracted (SC-235).
 *
 * A key that carries half a sentence cannot be reordered, and word order is
 * the first thing that changes between languages. The translator returns
 * something grammatical, the review passes, and the sentence is wrong — so the
 * failure mode is not a missing string, it is a confident one.
 *
 * **Reviewing `en.json` by eye does not find these**, which is why they are
 * checked here instead. Two of the three shapes below are only visible with
 * the markup and the key side by side, and `en.json` is precisely the artefact
 * that has the markup removed.
 *
 * The shape no value can reveal is the third one SC-235 names: a key whose
 * subject is supplied by its position on screen. `"Displays as USDC"` on a
 * badge beside the symbol it describes is a complete-looking string with no
 * whitespace, no punctuation and no concatenation — nothing mechanical marks
 * it. That one is held by `the lookalike badge offers its subject`, which
 * checks the call site rather than the value.
 */

const V3_SRC = resolve(import.meta.dir, '../../src/v3');
const V3_LOCALE = resolve(V3_SRC, 'i18n/locales/en.json');

/**
 * Keys that legitimately start with punctuation because the punctuation is
 * INSIDE the sentence rather than joining it to something outside.
 *
 * Nothing is here. It exists so that adding one is a deliberate act with a
 * reason beside it, rather than a rule quietly relaxed.
 */
const FRAGMENT_EXEMPT = new Set<string>();

/**
 * Files whose template literals join whole SENTENCES with a space, reviewed by
 * hand and kept few.
 *
 * A sentence boundary is the one join that is safe in every language. Both
 * files here build confirmation copy by joining independently pluralised
 * sentences, which is the arrangement that lets each carry its own count — see
 * `discardedClauses` in `lib/money.ts` for why that cannot be one key.
 */
const SENTENCE_JOIN_ALLOWED = new Set(['lib/money.ts', 'lib/transfer-review.ts']);

/** Every leaf of the locale file as `[dotted key, English value]`. */
function localeEntries(): [string, string][] {
  const json = JSON.parse(readFileSync(V3_LOCALE, 'utf8')) as Record<string, unknown>;
  const out: [string, string][] = [];
  const walk = (node: unknown, prefix: string): void => {
    if (typeof node === 'string') {
      out.push([prefix, node]);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [k, v] of Object.entries(node)) walk(v, prefix ? `${prefix}.${k}` : k);
  };
  walk(json, '');
  return out;
}

function relative(file: string): string {
  return file.slice(V3_SRC.length + 1);
}

/**
 * The lines of a file that are code, with comments dropped.
 *
 * Block state, not a per-line prefix test, and for the same reason
 * `scan-v3-strings.ts` needs one: a multi-line `{/* … *\/}` continues with
 * prose that starts with whatever the sentence starts with. The file that
 * explains why `<Trans>` beats concatenation does so by writing the
 * concatenation out, and a rule that cannot tell the argument from the defect
 * flags its own documentation.
 */
function codeLines(text: string): { line: string; number: number }[] {
  const out: { line: string; number: number }[] = [];
  let inBlock = false;
  for (const [index, line] of text.split('\n').entries()) {
    const opens = /\/\*/.test(line);
    const closes = /\*\//.test(line);
    if (inBlock) {
      if (closes) inBlock = false;
      continue;
    }
    if (opens && !closes) {
      inBlock = true;
      continue;
    }
    if (/^\s*(\/\/|\*|\{?\/\*)/.test(line)) continue;
    out.push({ line, number: index + 1 });
  }
  return out;
}

/**
 * The static text of every template literal on a line — what the CODE
 * contributes to the string, as opposed to what the interpolations do.
 */
function templateStatics(line: string): string[] {
  return [...line.matchAll(/`([^`]*)`/g)].flatMap((m) => (m[1] ?? '').split(/\$\{[^}]*\}/));
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'i18n') walk(full);
        continue;
      }
      if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(full);
    }
  };
  walk(V3_SRC);
  return out;
}

describe('a v3 key is a whole thing a translator can move', () => {
  /**
   * Leading or trailing whitespace means the key is glued to something the
   * translator cannot see, let alone reposition.
   *
   * `" unconverted"` rendered after a figure, `"Excludes 3 holdings worth "`
   * rendered before one: each is half a sentence with the other half in the
   * JSX. A language that puts the qualifier first has no way to say so.
   */
  test('no key is a fragment glued to its neighbour', () => {
    const glued = localeEntries()
      .filter(([key]) => !FRAGMENT_EXEMPT.has(key))
      .filter(([, value]) => value !== value.trim())
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
    expect(glued).toEqual([]);
  });

  /**
   * A leading separator does the same job as leading whitespace — it pins the
   * key to the right of something else. `"· file removed"` and `", sync
   * overdue"` are appended clauses whose position is decided by the `+` that
   * builds them.
   *
   * A quote or a currency symbol opens a sentence legitimately; a middot,
   * comma, semicolon, plus or dash does not.
   */
  test('no key opens with a separator that pins it to the right of something', () => {
    const pinned = localeEntries()
      .filter(([key]) => !FRAGMENT_EXEMPT.has(key))
      .filter(([, value]) => /^[·,;+•\-–—|/]/.test(value))
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
    expect(pinned).toEqual([]);
  });

  /**
   * Two `t()` calls inside one template literal is a sentence assembled in
   * code, and code is then where the word order lives.
   *
   * The check is a line-level one because that is the shape it can be sure
   * about: a template literal holding two calls. Files that join whole
   * sentences that way are named in `SENTENCE_JOIN_ALLOWED` with the reason.
   */
  test('no sentence is assembled from two keys in a template literal', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (SENTENCE_JOIN_ALLOWED.has(relative(file))) continue;
      for (const { line, number } of codeLines(readFileSync(file, 'utf8'))) {
        if (!line.includes('`')) continue;
        if ((line.match(/\bt\(/g)?.length ?? 0) < 2) continue;
        offenders.push(`${relative(file)}:${number} ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * English prose in a template literal beside a `t()` call.
   *
   * A join is only safe when the code contributes SEPARATORS — a space, a
   * middot, a comma between items of a list. The moment a word lives out
   * there, part of the sentence is in the source file and no locale file can
   * reach it: ` ${t('fileRemoved')}` after "· " put the middot in code, and
   * `"cost " + <figure>` put the noun there.
   *
   * Separator-joined ENUMERATIONS pass deliberately. `${kind} · ${location}`
   * is a list of independent facts, not a sentence, and a translator has
   * nothing to reorder in it.
   *
   * Prose is a letter AND a space. Without the space this fires on every DOM
   * id and every key built from a namespace — `${fieldId}-name`,
   * `${namespace}.every_${unit}` — which are identifiers nobody translates.
   * A single word glued to a key with no space is left to the rule above,
   * which sees the two calls it takes to make one.
   */
  test('no English word is joined to a key in code', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const { line, number } of codeLines(readFileSync(file, 'utf8'))) {
        if (!/\bt\(/.test(line)) continue;
        const prose = templateStatics(line).filter(
          (part) => /\p{L}/u.test(part) && /\s/.test(part)
        );
        if (prose.length === 0) continue;
        offenders.push(`${relative(file)}:${number} ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The shape no value can reveal: a label whose subject is the row it sits
   * beside.
   *
   * `"Displays as {{impersonates}}"` reads correctly in English only because
   * the badge is next to `UЅDС`. A translator gets a clause with no subject
   * and cannot state one — unless the call site offers a slot for it, which is
   * what this asserts. English does not spend the badge width on `{{symbol}}`;
   * a language that needs the subject named can.
   */
  test('the lookalike badge offers its subject', () => {
    // Two files since SC-559, and the split is the point rather than an
    // accident: the BADGE moved to a module of its own because the peek
    // sheet prints the symbol too — as the unit on the amount — and
    // `holdingsConfig` imports `holdingPeek`, so the badge could not travel
    // in the direction the second caller needed. The SPOKEN form did not
    // move: it is part of the row's `ariaLabel`, which only the list builds.
    const badge = readFileSync(resolve(V3_SRC, 'components/holdings/LookalikeBadge.tsx'), 'utf8');
    expect(badge).toMatch(/t\('v3\.holdings\.badge\.lookalike', \{ symbol, impersonates \}\)/);

    const config = readFileSync(resolve(V3_SRC, 'components/holdings/holdingsConfig.tsx'), 'utf8');
    expect(config).toMatch(/'v3\.holdings\.badge\.lookalikeSpoken',\s*\{\s*symbol:/);
  });
});
