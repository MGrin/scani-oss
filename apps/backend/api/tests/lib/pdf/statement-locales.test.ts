import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { StatementTextDtoType } from '@scani/shared';
import { isOfferedLanguage } from '../../../../../frontend/app/src/i18n/offered-languages';
import { loadTypesetter, UNSUPPORTED_MARK } from '../../../src/lib/pdf/fonts';
import { headerText } from '../../../src/lib/pdf/layout';
import {
  renderStatement,
  type StatementInput,
  statementText,
  UNSUPPORTED_NOTE,
} from '../../../src/lib/pdf/statement';
import { drawnCodepoints } from './drawn-codepoints';

/**
 * SC-1199. The statement's own words — `TOTAL`, `Page 2 of 3`, the metadata
 * labels — were English literals in the renderer whatever the reader chose.
 * They now arrive translated from the client, and this is the proof at the only
 * level the ruling accepts: **a rendered PDF per locale**, asked what reached
 * the page.
 *
 * **Derived from the locale directory, never a list.** Eight languages render
 * here today and a new one will with nothing to edit. A floor assertion stands
 * above them, because `it.each` over an empty array registers no tests and bun
 * reports that as a clean run.
 *
 * **A held language is named, not checked (SC-201).** Arabic's locale file
 * lands before the faces that can set Arabic script, so a statement in its
 * words cannot reach the page yet. Checking it would make the branch that adds
 * the words red until the branch that adds the faces merges. The hold in
 * `offered-languages.ts` already says a language is not ready. The PR that
 * lifts it is the PR that ships the faces, so that is where this check turns
 * on for it.
 *
 * The words are read from the locale FILES the app ships rather than through
 * i18next, whose test preload registers English and Russian only — a file read
 * reaches every language, including one added tomorrow, with nothing to
 * register. The client's own test (`apps/frontend/app/tests/v3/lib/pdf-export.test.ts`)
 * proves it reads these same keys; this proves those words reach a page.
 */

const REPO = resolve(import.meta.dir, '../../../../../..');
const APP_LOCALES = join(REPO, 'apps/frontend/app/src/i18n/locales');
const UI_EN = join(REPO, 'packages/frontend/ui/src/i18n/locales/en.json');

type Tree = { [key: string]: string | Tree };

function at(tree: Tree, path: string): string {
  const value = path
    .split('.')
    .reduce<string | Tree | undefined>(
      (node, key) => (typeof node === 'object' ? node[key] : undefined),
      tree
    );
  if (typeof value !== 'string') throw new Error(`missing ${path}`);
  return value;
}

const shipped = readdirSync(APP_LOCALES)
  .filter((file) => file.endsWith('.json') && file !== 'en.json')
  .map((file) => [file.replace(/\.json$/, ''), join(APP_LOCALES, file)] as const);

const locales = [['en', UI_EN] as const, ...shipped.filter(([code]) => isOfferedLanguage(code))];
const held = shipped.filter(([code]) => !isOfferedLanguage(code)).map(([code]) => code);

/** The words one locale file gives the statement — the keys `statementText` in
 *  `pdf-export.ts` reads, with the two formatted values supplied here. */
async function wordsOf(file: string): Promise<StatementTextDtoType> {
  const tree = (await Bun.file(file).json()) as Tree;
  return {
    total: at(tree, 'ui.export.statement.total'),
    pageOf: at(tree, 'ui.export.statement.pageOf'),
    account: at(tree, 'ui.export.statement.account'),
    generated: at(tree, 'ui.export.provenance.generated'),
    generatedAt: '15 · 09 · 2026',
    rows: at(tree, 'ui.export.provenance.rows'),
    rowCount: '12',
    amounts: at(tree, 'ui.export.provenance.amounts'),
    amountsWithheld: at(tree, 'ui.export.provenance.withheld'),
    characters: at(tree, 'ui.export.statement.characters'),
    unsupportedNote: at(tree, 'ui.export.statement.unsupportedNote'),
    noRows: at(tree, 'ui.export.statement.noRows'),
  };
}

/** Totals, a withheld-amounts line and a metadata block, so every word this
 *  statement owns is SET — a word never drawn cannot be asserted drawn. The
 *  empty-selection sentence needs a second render; see below. */
function statement(text: StatementTextDtoType | undefined, rowCount = 3): StatementInput {
  return {
    account: 'Ada Lovelace (ada@example.com)',
    sheet: {
      name: 'Holdings',
      headers: ['Holding', 'Value'],
      numericColumns: [false, true],
      totalColumns: [false, true],
      rows: Array.from({ length: rowCount }, (_, index) => [
        { kind: 'text', value: `Holding ${index}` },
        { kind: 'number', value: `${1000 + index}`, decimals: 2, style: 'money', currency: 'EUR' },
      ]),
    },
    provenance: {
      subject: 'Holdings',
      scope: 'All holdings',
      generatedAt: '2026-09-15T05:31:00.000Z',
      details: [],
      rowCount,
      amountsWithheld: true,
    },
    ...(text ? { text } : {}),
  };
}

/** The characters of a translated word that must be on the page: its
 *  placeholders are filled by the renderer, and spaces are not glyphs. */
function letters(word: string): number[] {
  return [...word.replace(/\{\{\w+\}\}/g, '')]
    .filter((character) => !/\s/u.test(character))
    .map((character) => character.codePointAt(0) as number);
}

describe('every locale the app ships sets the statement in its own words', () => {
  it('the locale list is not empty, so nothing below passes by checking nothing', () => {
    expect(locales.length).toBeGreaterThanOrEqual(8);
    expect(locales.map(([code]) => code)).toContain('en');
    expect(locales.map(([code]) => code)).toContain('ja');
  });

  it('a held language is skipped by name, and only while it is held', () => {
    // Every shipped file is either checked below or listed here, so a skip can
    // never be silent. When the hold lifts, this list empties and the language
    // is in `locales` above.
    expect([...locales.map(([code]) => code), ...held].sort()).toEqual(
      ['en', ...shipped.map(([code]) => code)].sort()
    );
    for (const code of held) expect(isOfferedLanguage(code)).toBe(false);
  });

  it.each(
    locales
  )('%s: every word reaches the page, in a face that can set it', async (_, file) => {
    const words = await wordsOf(file);
    const type = await loadTypesetter();
    const drawn = drawnCodepoints(await renderStatement(statement(words)));
    const empty = drawnCodepoints(await renderStatement(statement(words, 0)));

    const onPage = (word: string, page: Set<number>) =>
      letters(word).filter((point) => !page.has(point));

    for (const key of [
      'pageOf',
      'account',
      'generated',
      'rows',
      'amounts',
      'amountsWithheld',
    ] as const) {
      // Missing code points NAMED, so a failure says which word lost which letter.
      expect({ key, missing: onPage(words[key], drawn) }).toEqual({ key, missing: [] });
      expect(type.supports(words[key])).toBe(true);
    }
    // The totals label is set in capitals, so the page carries `ИТОГО` and never
    // the `г` of `Итого`; asking for the lowercase would fail on a correct page.
    expect({ key: 'total', missing: onPage(headerText(words.total), drawn) }).toEqual({
      key: 'total',
      missing: [],
    });
    expect(type.supports(headerText(words.total))).toBe(true);
    expect({ key: 'noRows', missing: onPage(words.noRows, empty) }).toEqual({
      key: 'noRows',
      missing: [],
    });
    // Never marked: a label the fonts cannot set would be disclosed as a
    // substitution and drawn as `[?]`, which is the failure this guards.
    expect(type.supports(words.characters)).toBe(true);
    expect(type.supports(words.unsupportedNote)).toBe(true);
  });

  it('control — the probe can say NO: a word never set is not found', async () => {
    // Without this, "every letter was drawn" and "the probe returns every code
    // point it is asked about" are the same reading. Han is not in any word of
    // the English statement, so its letters must be absent from that page.
    const english = await wordsOf(UI_EN);
    const drawn = drawnCodepoints(await renderStatement(statement(english)));
    expect(drawn.has('合'.codePointAt(0) as number)).toBe(false);
    expect(drawn.has('T'.codePointAt(0) as number)).toBe(true);
  });
});

describe('what the renderer does with the words it is sent', () => {
  it('a client that sends every word gets none of the English back', async () => {
    const japanese = await wordsOf(join(APP_LOCALES, 'ja.json'));
    const resolved = statementText(statement(japanese));
    expect(resolved).toEqual(japanese);
  });

  it('a client that sends nothing gets exactly the statement it always got', () => {
    // The stale-PWA guarantee: an installed build too old to send `text` must
    // get today's document, not a validation error and not a different one.
    const resolved = statementText(statement(undefined));
    expect(resolved.total).toBe('Total');
    expect(resolved.pageOf).toBe('Page {{page}} of {{pages}}');
    expect(resolved.generatedAt).toBe('15 September 2026 at 05:31 UTC');
    expect(resolved.rowCount).toBe('3');
    expect(resolved.unsupportedNote.replace('{{mark}}', UNSUPPORTED_MARK)).toBe(UNSUPPORTED_NOTE);
  });
});
