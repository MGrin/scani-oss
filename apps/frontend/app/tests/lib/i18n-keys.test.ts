import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import shellEn from '../../src/i18n/locales/en.json';
import v3En from '../../src/v3/i18n/locales/en.json';

/**
 * The two halves of one locale, back together (SC-169).
 *
 * v3's strings ship in the v3 chunk now, so they live in `src/v3/i18n/locales/`
 * — but every rule below is about the bundle a reader ends up with, which is
 * the merge. `i18n-locales.test.ts` gates the split itself.
 */
const en = { ...shellEn, ...v3En };

/**
 * Every key v3 asks for exists in `en.json` (SC-201 step 1).
 *
 * This is the gate on the one property step 1 claims: **no behaviour change**.
 * Its failure mode is the reason it has to be a test rather than a review —
 * i18next resolves a missing key to *the key itself*, so a typo renders
 * `v3.money.vendorList.emptyTitle` on the screen instead of "No vendors yet",
 * and nothing throws, nothing logs, and the layout barely moves. On a surface
 * with 400 strings that is invisible until a user reports it.
 *
 * Three rules, each of which has already caught something:
 *
 * 1. **Every literal key resolves.** Including the `labelKey` fields that
 *    `V3_TAB_ITEMS` and friends hand to `t()` at render time — those are the
 *    keys most likely to rot, because grep for `t('nav.home')` does not find
 *    them.
 * 2. **No inline default text.** `t('key', 'Some text')` and
 *    `{ defaultValue: … }` both put an English string next to a key, which is
 *    exactly how two spellings of one sentence start drifting: the translator
 *    sees `en.json`, the reader sees the default, and nothing reconciles them.
 * 3. **Every key that takes a count has both plural forms.** A `_one` without
 *    an `_other` renders the key for every plural but one, and English —
 *    where the two forms differ by a letter — is the worst language to notice
 *    it in.
 */

const V3_ROOT = join(import.meta.dir, '../../src/v3');

/**
 * The shell's pages are keyed too, and were not gated (SC-405).
 *
 * This file walked `src/v3` alone, because SC-202 scoped extraction there. So
 * when the sign-in screen was keyed, the one rule that catches a typo in a key
 * did not cover the one screen every signed-out reader sees — and i18next
 * resolves a missing key to the key itself, so `auth.signIn.titel` would render
 * as `auth.signIn.titel` in 48px type with nothing thrown and nothing logged.
 *
 * `src/pages` and not `src/`: the shell's other directories are unkeyed and
 * each is its own decision. The largest of them was `src/v2`, frozen and
 * unkeyed by design under SC-235 and deleted by SC-423.
 */
const KEYED_ROOTS = [V3_ROOT, join(import.meta.dir, '../../src/pages')];

function keyedSources(): string[] {
  return KEYED_ROOTS.flatMap(sourceFiles);
}

/** `pages/KitchenSinkPage.tsx` is the unlinked primitive gallery — out of
 *  scope for translation, so out of scope for this gate too. */
const EXCLUDED = ['KitchenSinkPage.tsx'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !EXCLUDED.includes(entry)) out.push(full);
  }
  return out;
}

interface KeyRef {
  file: string;
  line: number;
  key: string;
  /** True when the call site passes `{ count }` and therefore needs plurals. */
  pluralised: boolean;
}

/**
 * Comments blanked, line numbers preserved.
 *
 * Not optional: this codebase explains itself at length, and a doc comment
 * that quotes the shape it is arguing against — "building this as
 * `t('includes') + <amounts/>` would…" — is indistinguishable from a call site
 * to a line-based regex. The first version of this file failed on exactly
 * that, reporting two keys missing that no rendered code ever asks for.
 */
function stripComments(src: string): string {
  let out = '';
  let inBlock = false;
  let inLine = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const next = src[i + 1];
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        out += '  ';
        i++;
      } else out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += '\n';
      } else out += ' ';
      continue;
    }
    // Deliberately NOT string-aware. Tracking quote state would mean treating
    // an apostrophe in JSX text — "today's rates" — as opening a string
    // literal, which swallows every `t('…')` after it on the line. The only
    // thing string-awareness buys is not mistaking `https://` for a comment,
    // and that is one cheap guard.
    if (c === '/' && next === '*') {
      inBlock = true;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '/' && src[i - 1] !== ':') {
      inLine = true;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

function collectKeys(): KeyRef[] {
  const refs: KeyRef[] = [];
  for (const file of keyedSources()) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      // `t('key')`, `t('key', { … })` — the quote style is Biome's, single.
      for (const m of line.matchAll(/\bt\(\s*'([^']+)'\s*(,\s*\{([^}]*)\})?/g)) {
        // Biome wraps a long call, which puts `{ count }` on the NEXT line,
        // out of a line-based match's reach. That produced a false FAILURE:
        // the key was reported missing, because the bare form does not exist
        // for a pluralised key, and the only way to satisfy it was to
        // hand-format the call site — which the formatter then undid.
        //
        // So when the args object is left open at the end of the line, read
        // on. Bounded to three lines, which is what a wrapped `t()` occupies;
        // an unbounded scan would start finding other calls' counts. It fails
        // safe: the worst it can do is accept `key_one`/`key_other` as
        // evidence for a call site that does not count, and a key with plural
        // forms defined is one somebody already decided is plural.
        const args = m[3] ?? '';
        const rest = line.slice(m.index ?? 0);
        const opensButDoesNotClose = /,\s*\{[^}]*$/.test(rest);
        const window =
          args || !opensButDoesNotClose
            ? args
            : (lines
                .slice(i, i + 3)
                .join(' ')
                .split(')')[0] ?? '');
        refs.push({
          file,
          line: i + 1,
          key: m[1]!,
          pluralised: /\bcount\b/.test(window),
        });
      }
      // Keys handed to `t()` indirectly — `{ labelKey: 'nav.home' }` and the
      // `…Key:` convention any future indirection must follow to stay
      // visible here.
      for (const m of line.matchAll(/\b\w*[kK]ey:\s*'([^']+)'/g)) {
        const key = m[1]!;
        // `pluralised: true` for an INDIRECT reference, always. A table entry
        // is handed to `t()` somewhere else entirely — `DUE_UNITS`' key is
        // resolved with a `{ count }` two functions away — so this file
        // cannot see whether the call site counts. Accepting either the bare
        // key or `_other` as evidence keeps the "no missing key" property,
        // which is the one that matters, and gives up only the ability to
        // demand plurals for keys nobody can prove need them.
        if (key.includes('.')) refs.push({ file, line: i + 1, key, pluralised: true });
      }
    });
  }
  return refs;
}

function resolve(key: string): unknown {
  let node: unknown = en;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

const REFS = collectKeys();

describe('i18n keys in the keyed roots', () => {
  test('the roots ask for keys at all — the scan is not silently empty', () => {
    // A regex that stops matching would make every assertion below pass
    // vacuously, which is the failure this file cannot afford.
    expect(REFS.length).toBeGreaterThan(50);
  });

  test('every key a keyed root references resolves to a string in en.json', () => {
    const missing = REFS.filter((r) => typeof resolve(r.key) !== 'string')
      // A pluralised key lives in en.json as `key_one` / `key_other`; the bare
      // key is correctly absent.
      .filter((r) => !(r.pluralised && typeof resolve(`${r.key}_other`) === 'string'))
      .map((r) => `${r.file.replace(/.*\/src\//, 'src/')}:${r.line} → ${r.key}`);
    expect(missing).toEqual([]);
  });

  test('no call site carries its own English text alongside the key', () => {
    const offenders: string[] = [];
    for (const file of keyedSources()) {
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          const where = `${file.replace(/.*\/src\//, 'src/')}:${i + 1}`;
          if (/\bt\(\s*'[^']+'\s*,\s*['"`]/.test(line)) offenders.push(`${where} (default arg)`);
          if (/\bdefaultValue\s*:/.test(line)) offenders.push(`${where} (defaultValue)`);
        });
    }
    expect(offenders).toEqual([]);
  });

  test('every test that imports v3 source loads the i18n preload first', () => {
    // The rule this enforces was documented and then immediately broken: five
    // tests rendered `aria-label="v3.home.vaults.progress"` — the raw KEY — and
    // passed their own assertions right up until one of them checked the
    // label's text. With no initialised instance `t()` returns its argument,
    // so a component test without this import asserts against key names and
    // calls it green.
    const TESTS = join(import.meta.dir, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry) || entry === 'i18n-preload.ts') continue;
        const src = readFileSync(full, 'utf8');
        if (!/from '(\.\.\/)+src\/v3\//.test(src)) continue;
        if (!src.includes('i18n-preload')) {
          offenders.push(full.replace(/.*\/tests\//, 'tests/'));
        }
      }
    };
    walk(TESTS);
    expect(offenders).toEqual([]);
  });

  test('every plural form actually interpolates its count', () => {
    // The property `money.test.ts` used to pin on one helper, generalised:
    // "Overdue, 8 bills" is only useful because it says 8. A plural pair whose
    // text drops `{{count}}` renders "Overdue, bills" and reads as a heading.
    const dropped: string[] = [];
    // The exception, enumerated rather than pattern-matched, because every
    // entry needs a reason and a regex cannot carry one.
    //
    // These are AGREEMENT frames: they are pluralised on a TOTAL in order to
    // pick a verb form, while the numbers themselves are already printed by
    // the clause keys interpolated into `{{clauses}}`. "1 payment and 1 alias
    // move to X" agrees with the whole subject, not with the last noun in it,
    // so the frame has to see the total — and printing it as well would give
    // "2: 1 payment and 1 alias move".
    const AGREEMENT_ONLY = new Set([
      'v3.money.deletePayment.discarded_one',
      'v3.money.deletePayment.discarded_other',
      'v3.money.mergeVendor.moves_one',
      'v3.money.mergeVendor.moves_other',
      // The count is inside `{{named}}` — a list of symbols — and at count 1
      // there is no number in the sentence at all, only "it is" vs "they are".
      'v3.groups.unpriced.note_one',
      'v3.groups.unpriced.note_other',
      // Same shape: the selection is printed as `{{symbols}}`, and the count
      // is there to choose "is"/"are" and "it"/"them". Printing it as well
      // would give "3: BTC, ETH and SOL are removed".
      // Identical shape one level up: the accounts are printed as `{{names}}`,
      // and the count only picks "is"/"are" and "it"/"them". Printing it too
      // would read "2: Spot and Savings are removed".
      'v3.entities.account.bulkDeleteConsequence_one',
      'v3.entities.account.bulkDeleteConsequence_other',
      'v3.holdings.bulk.deleteConsequence_one',
      'v3.holdings.bulk.deleteConsequence_other',
      // "Repeats every week" — at one occurrence English states the period as
      // a bare noun and prints no number, exactly as the field's own default
      // of "1" reads today. The count is there to choose the noun's form,
      // which is the whole reason these are per-unit plural keys rather than
      // one frame with `{{unit}}` in it.
      // "See payment" / "See payments" — the button beside a fact that has
      // just printed the number ("Payments: 3"). The count picks the noun and
      // printing it again would give "See 3 payments" under "Payments 3".
      // "Already have a vendor / vendors with a similar name:" — the count
      // picks `a vendor` against `vendors` and prints no number, because the
      // names themselves are the chips directly below the sentence (SC-368).
      'v3.money.vendorField.similarNames_one',
      'v3.money.vendorField.similarNames_other',
      'v3.money.vendorPeek.seePayments_one',
      'v3.money.vendorPeek.seePayments_other',
      'v3.money.paymentForm.repeatWeek_one',
      'v3.money.paymentForm.repeatMonth_one',
      'v3.money.paymentForm.repeatQuarter_one',
      'v3.money.paymentForm.repeatYear_one',
      // "Every month", the cadence the Money tab prints on a row (SC-320) —
      // the same shape as the four above, one level of prose down. "Every 1
      // month" is not English, so the count selects the noun and stays out of
      // the sentence. `tests/v3/lib/paymentTotals.test.ts` pins the wording,
      // because the key is built from the unit and no literal scan sees it.
      'v3.money.cadence.every_week_one',
      'v3.money.cadence.every_month_one',
      'v3.money.cadence.every_quarter_one',
      'v3.money.cadence.every_year_one',
      // SC-625's two buttons in the forecast's caveat blocks. The count picks
      // "it/its" against "them/their" and prints no number, because the number
      // is already in the line DIRECTLY ABOVE each button — `couldEstimate`
      // above `useLastSettled` ("2 of them have settled before…"), and
      // `estimatedCount` above `stopEstimating` ("3 variable payments are
      // priced from their last settled amount…"). "Use 2 their last settled
      // amounts" is not English.
      //
      // Identical shape to `vendorPeek.seePayments_*` above, and falsifiable
      // in one step rather than on my word: if either of those two sibling
      // keys ever stops printing `{{count}}`, these four lose their reason and
      // belong back inside the rule. `tests/v3/components/forecast.test.tsx`
      // pins the rendered sentence ("1 of them has settled before").
      'v3.money.forecast.useLastSettled_one',
      'v3.money.forecast.useLastSettled_other',
      'v3.money.forecast.stopEstimating_one',
      'v3.money.forecast.stopEstimating_other',
    ]);
    /**
     * A data-view noun is plural-formed but does NOT count (SC-257).
     *
     * `ui.dataView.noun.holdings_one` is "holding" and `_other` is "holdings"
     * — the bare noun in the form the count selects, for the frames that read
     * "Search holdings" and "This holding is not on this list". The counted
     * phrase is the SAME key under i18next's `counted` context, and those
     * forms do carry `{{count}}`, so they stay inside the rule.
     *
     * A family rather than 28 entries in the set below: every member has the
     * same reason, the shape is structural rather than case-by-case, and a
     * list that long would bury the exemptions that are genuinely ad-hoc.
     */
    /**
     * `{{count}}` and `{{count, number}}` both satisfy this rule.
     *
     * The property is that the number reaches the sentence, not how it is
     * spelled — `{{key, format}}` is i18next's own interpolation syntax and
     * prints the same value through `Intl`. `v3.common.relative.*` uses the
     * formatted form so the numeral follows the reader's locale as well as the
     * words (SC-369), and a literal `includes('{{count}}')` read that as a
     * dropped count. Widening it here rather than adding six entries to
     * `AGREEMENT_ONLY`, which is for keys that deliberately print NO number:
     * exempting these would have stopped checking the one thing they do.
     */
    const interpolatesCount = (text: string): boolean => /\{\{count(,[^}]*)?\}\}/.test(text);

    const isBareDataViewNoun = (path: string): boolean =>
      /^ui\.dataView\.noun\./.test(path) && !/_counted_(one|other|two|few|many|zero)$/.test(path);

    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        if (
          /_(one|other|two|few|many|zero)$/.test(path) &&
          !interpolatesCount(node) &&
          !AGREEMENT_ONLY.has(path) &&
          !isBareDataViewNoun(path)
        ) {
          dropped.push(`${path} → ${node}`);
        }
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    };
    walk(en, '');
    expect(dropped).toEqual([]);

    // A stale allowlist is a hole in the rule. Every exemption must still name
    // a key that exists and still be needed.
    const stale = [...AGREEMENT_ONLY].filter((key) => {
      const text = resolve(key);
      return typeof text !== 'string' || interpolatesCount(text);
    });
    expect(stale).toEqual([]);
  });

  test('a key the DATA-VIEW KIT resolves lives under `ui.`', () => {
    // `nounKey`, `headerKey`, `labelKey`, `titleKey` and friends are handed to
    // `@scani/ui`, which resolves them against ITS OWN i18next instance
    // (SC-250). That instance only receives the `ui.` half of this app's
    // bundle — `src/i18n/index.ts` forwards `bundle.ui` and nothing else — so a
    // key under any other prefix resolves to itself and paints on the screen.
    //
    // That is not hypothetical: SC-257 shipped exactly this bug through a
    // different route (`en-GB` vs `en`) and every list rendered
    // `ui.dataView.noun.holdings` until a browser found it. A prefix rule that
    // only lives in a comment is the same defect waiting for a second cause.
    const KIT_KEYS =
      /\b(?:noun|header|label|title|description|searchPlaceholder|valueHeader)Key:\s*'([^']+)'/g;
    // Only files that actually build a data-view config. `lib/routes.ts` also
    // uses a `labelKey` — `nav.home` — but the APP resolves that one, so the
    // `ui.` rule does not apply to it and asserting it would be a rule about
    // the wrong thing.
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of sourceFiles(V3_ROOT)) {
      const raw = readFileSync(file, 'utf8');
      if (!raw.includes('v3/lib/data-view')) continue;
      scanned++;
      stripComments(raw)
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(KIT_KEYS)) {
            if (!m[1]!.startsWith('ui.')) {
              offenders.push(`${file.replace(/.*\/src\//, 'src/')}:${i + 1} → ${m[1]}`);
            }
          }
        });
    }
    // Every list surface in v3 builds one, so a collapse here means the import
    // moved and the rule stopped being checked.
    expect(scanned).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  test('every counted key has both plural forms', () => {
    const broken = REFS.filter((r) => r.pluralised)
      // …except the ambiguous indirect ones, which resolve bare.
      .filter((r) => typeof resolve(r.key) !== 'string')
      .filter(
        (r) =>
          typeof resolve(`${r.key}_one`) !== 'string' ||
          typeof resolve(`${r.key}_other`) !== 'string'
      )
      .map((r) => `${r.file.replace(/.*\/src\//, 'src/')}:${r.line} → ${r.key}`);
    expect(broken).toEqual([]);
  });
});
