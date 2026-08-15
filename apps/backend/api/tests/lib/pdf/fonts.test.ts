import { describe, expect, it } from 'bun:test';
import { loadTypesetter, UNSUPPORTED_MARK } from '../../../src/lib/pdf/fonts';

/**
 * Which face draws which character — SC-127.
 *
 * The bug this replaces was invisible to every test that existed: the statement
 * rendered, it had the right number of pages, and `Сбербанк` was eight empty
 * boxes. So the assertions here are about *coverage* and about what happens when
 * there is none, which is the only level at which that failure is visible
 * without looking at a page.
 */

const type = await loadTypesetter();

const drawn = (text: string, face: 'sans' | 'bold' | 'mono' = 'sans'): string =>
  type
    .shape(text, face)
    .map((run) => run.text)
    .join('');

const faces = (text: string, face: 'sans' | 'bold' | 'mono' = 'sans'): string[] =>
  type.shape(text, face).map((run) => run.font);

describe('typesetter', () => {
  it('sets plain Latin as a single run', () => {
    expect(type.shape('Vanguard FTSE All-World', 'sans')).toEqual([
      { font: 'Sans', text: 'Vanguard FTSE All-World' },
    ]);
  });

  it.each([
    ['Żabka Polska', 'Latin Extended-A'],
    ['Сбербанк', 'Cyrillic'],
    ['Société Générale', 'Latin-1'],
    ['Ελληνική Τράπεζα', 'Greek'],
    ['Ngân hàng Việt Nam', 'Vietnamese'],
    ['ЮMoney · Тинькофф', 'Cyrillic mixed with Latin'],
  ])('draws every character of %s (%s)', (name) => {
    expect(drawn(name)).toBe(name);
    expect(type.supports(name)).toBe(true);
  });

  it('crosses a subset boundary mid-word without dropping the character', () => {
    // `Ż` is Latin Extended-A and `abka` is not, and the two live in different
    // files — which is the whole defect: the statement embedded only the second.
    expect(drawn('Żabka')).toBe('Żabka');
    expect(faces('Żabka')).toEqual(['Sans-Ext', 'Sans']);
  });

  it('merges neighbours that share a face into one run', () => {
    expect(type.shape('Сбербанк', 'sans')).toHaveLength(1);
  });

  it('marks what no face covers instead of drawing a box', () => {
    expect(drawn('三菱UFJ銀行')).toBe(`${UNSUPPORTED_MARK}UFJ${UNSUPPORTED_MARK}`);
    expect(type.supports('三菱UFJ銀行')).toBe(false);
  });

  it('collapses a run of unsupported characters to one mark', () => {
    // Six marks is not six times the information of one, and it would set the
    // name three times wider than it is.
    expect(drawn('한국투자증권')).toBe(UNSUPPORTED_MARK);
  });

  it('draws the mark in a face the document already has', () => {
    expect(faces('三菱')).toEqual(['Sans']);
    expect(faces('三菱', 'bold')).toEqual(['Bold']);
  });

  it('keeps figures in the mono face', () => {
    expect(type.shape('1,204.30', 'mono')).toEqual([{ font: 'Mono', text: '1,204.30' }]);
  });

  it('falls through to sans for a script Plex Mono has no cut for', () => {
    // Mono ships no Greek. A text cell in a figure column set in the wrong face
    // is a smaller loss than a name replaced by a mark.
    expect(faces('Ω', 'mono')).toEqual(['Sans-Greek']);
    expect(drawn('Ω', 'mono')).toBe('Ω');
  });

  it('registers every face it can name a run with', () => {
    const registered: string[] = [];
    type.register({
      registerFont: (name: string) => registered.push(name),
    } as unknown as PDFKit.PDFDocument);
    for (const name of faces('Żabka Сбербанк Ελληνική Việt')) {
      expect(registered).toContain(name);
    }
  });
});
