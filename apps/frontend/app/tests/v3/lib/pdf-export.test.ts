import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import {
  AUTO_REGION,
  FigureSeparatorsDto,
  FORMAT_REGIONS,
  LANGUAGE_FORMATS,
  resolveFormatLocale,
  StatementTextDto,
} from '@scani/shared';
import { uiT } from '@scani/ui/i18n';
import i18n from 'i18next';
import { figureSeparators, statementText, withDisplayDates } from '../../../src/v3/lib/pdf-export';

/**
 * The words the app sends the PDF renderer (SC-1199).
 *
 * The renderer's own test proves every locale file's words reach a page; this
 * proves the client reads THOSE keys, in the reader's language, and formats the
 * two values the renderer no longer formats. A key typed wrong here would send
 * `ui.export.statement.totl` to the page, and a server test reading the locale
 * files directly would never see it.
 */

const GENERATED = new Date('2026-09-15T05:31:00.000Z');
const ru = i18n.getFixedT('ru') as unknown as typeof uiT;

describe('statementText', () => {
  test('English is the statement the server printed before, word for word', () => {
    const text = statementText(GENERATED, 1234, uiT, 'en-GB');
    expect(text.total).toBe('Total');
    expect(text.pageOf).toBe('Page {{page}} of {{pages}}');
    expect(text.account).toBe('Account');
    expect(text.noRows).toBe('No rows in this selection.');
    // The en-GB pin the server carried, now the client's: byte-identical.
    expect(text.generatedAt).toBe('15 September 2026 at 05:31 UTC');
    expect(text.unsupportedNote.startsWith('{{mark}} marks a character')).toBe(true);
  });

  test('it is a valid wire payload, and no field is a raw key', () => {
    const text = statementText(GENERATED, 1234, uiT, 'en-GB');
    expect(StatementTextDto.safeParse(text).success).toBe(true);
    const raw = Object.entries(text).filter(([, value]) => value?.startsWith('ui.'));
    expect(raw).toEqual([]);
  });

  test('Russian is Russian, with the placeholders left for the renderer', () => {
    const text = statementText(GENERATED, 1234, ru, 'ru-RU');
    expect(text.total).toBe('Итого');
    expect(text.pageOf).toBe('Страница {{page}} из {{pages}}');
    // The signed-in USER, as settings call it — not the column word `Счёт`.
    expect(text.account).toBe('Учётная запись');
    expect(text.unsupportedNote.startsWith('{{mark}} ')).toBe(true);
    expect(text.generatedAt).toBe(
      GENERATED.toLocaleString('ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
        timeZoneName: 'short',
      })
    );
    // Control: the same key in English differs, so the Russian above is not an
    // English fallback that happens to match.
    expect(text.total).not.toBe(statementText(GENERATED, 1234, uiT, 'en-GB').total);
  });

  test('a count the workbook does not know is not invented', () => {
    expect(statementText(GENERATED, undefined, uiT, 'en-GB').rowCount).toBeUndefined();
  });
});

describe('figureSeparators', () => {
  test('French, Spanish and English spell a figure three different ways', () => {
    expect(figureSeparators('fr-FR')).toEqual({ group: '\u202f', decimal: ',' });
    expect(figureSeparators('es-ES')).toEqual({ group: '.', decimal: ',' });
    expect(figureSeparators('en-US')).toEqual({ group: ',', decimal: '.' });
    expect(FigureSeparatorsDto.safeParse(figureSeparators('fr-FR')).success).toBe(true);
  });
});

/**
 * Two characters cannot say WHERE the groups fall, and the renderer puts one
 * every three digits. That is true of every locale the app can resolve today,
 * and false of `en-IN` (`12,34,567`) — so a language or region added later that
 * groups otherwise must redden here, not print a wrong-looking total on an
 * accountant's statement.
 *
 * Every language × every region the setting can offer, plus "auto", because a
 * region is chosen independently of the language.
 */
describe('every resolvable number locale groups by three', () => {
  const combinations = Object.keys(LANGUAGE_FORMATS).flatMap((language) =>
    [AUTO_REGION, ...FORMAT_REGIONS].map(
      (region) => [language, region, resolveFormatLocale(language, region).numberLocale] as const
    )
  );

  const groupLengths = (locale: string) =>
    new Intl.NumberFormat(locale)
      .formatToParts(123456789012)
      .filter((part) => part.type === 'integer')
      .map((part) => [...part.value].length);

  test('the list is not empty, so nothing below passes by checking nothing', () => {
    expect(combinations.length).toBeGreaterThanOrEqual(8 * (FORMAT_REGIONS.length + 1));
  });

  test.each(combinations)('%s with region %s (%s)', (_, __, locale) => {
    expect(groupLengths(locale)).toEqual([3, 3, 3, 3]);
  });

  test('control — the check can say no: Indian English groups by two', () => {
    expect(groupLengths('en-IN')).not.toEqual([3, 3, 3, 3]);
  });
});

describe('withDisplayDates', () => {
  const sheet = {
    name: 'Holdings',
    headers: ['Bought', 'Synced', 'Note'],
    numericColumns: [false, false, false],
    rows: [
      [
        { kind: 'date', value: '2026-08-14T00:00:00.000Z', withTime: false },
        { kind: 'date', value: '2026-08-14T23:31:00.000Z', withTime: true },
        { kind: 'text', value: 'x' },
      ],
    ],
  } as const;

  test('adds the words and keeps the value a machine parses', () => {
    const [row] = withDisplayDates(structuredClone(sheet) as never, 'fr-FR').rows;
    expect(row?.[0]).toEqual({
      kind: 'date',
      value: '2026-08-14T00:00:00.000Z',
      withTime: false,
      display: new Date('2026-08-14T00:00:00.000Z').toLocaleDateString('fr-FR', {
        dateStyle: 'medium',
        timeZone: 'UTC',
      }),
    });
    expect(row?.[2]).toEqual({ kind: 'text', value: 'x' });
  });

  test('in UTC, so a late-evening time does not move to the next day', () => {
    const [row] = withDisplayDates(structuredClone(sheet) as never, 'en-GB').rows;
    const cell = row?.[1] as { display?: string };
    expect(cell.display).toContain('14 Aug 2026');
    expect(cell.display).toContain('23:31');
  });
});
