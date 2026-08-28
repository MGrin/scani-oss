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

/**
 * COVERAGE FOR A JOINING OR RTL SCRIPT IS REFUSED UNTIL THE RENDERER ORDERS RUNS
 * VISUALLY (SC-763).
 *
 * The detector that makes an unsettable character visible — `[?]` plus the
 * metadata note — is `supports()`, and `supports()` is pure codepoint coverage.
 * So it goes blind at the exact moment coverage arrives. Bundle an Arabic face
 * and `covers.has` goes true, `supports()` goes true, the mark and the note
 * disappear, and the failure upgrades from loud-and-unusable to
 * silent-and-plausible.
 *
 * WHAT IS ACTUALLY MISSING IS NOT SHAPING. That was measured rather than
 * assumed, because the ticket asserted the opposite: fontkit 2.0.4 ships
 * `ArabicShaper.js` and pdfkit 0.19.1 calls `font.layout(text, features)`.
 * Laying out `سلام` returns three glyphs for four codepoints — the mandatory
 * lam-alef ligature — with contextual ids and RTL reordering, against a Latin
 * control that comes back identical to its isolated forms. Glyphs are fine.
 *
 * What is missing is BIDI, in our own draw path: `statement.ts` emits run by run
 * at explicit x, advancing left to right, and runs split on face boundaries
 * (`'Сбербанк ABC'` is two runs). A bundled Arabic face therefore yields
 * `'بنك ABC'` in logical order — correct glyphs, wrong place, no mark.
 *
 * WHY THIS IS AN IMPLICATION AND NOT A CONJUNCTION. The tempting form is "an RTL
 * face is bundled AND the draw path is bidi-naive". The second half is not
 * mechanically knowable, so it would have to be a flag or an exemption list —
 * and on the day the guard reds, the cheapest clearance is flipping it, decided
 * while staring at a red build. That is the escape hatch CLAUDE.md names.
 *
 * So the second half is not modelled at all. The antecedent is measured
 * coverage; the consequent is a refusal. Lifting it costs what it claims:
 * REPLACE THIS TEST WITH THE RUN-ORDER ASSERTION — that a mixed RTL/LTR line is
 * drawn in visual order — and make it pass. There is no cheaper clearance,
 * because there is nothing here to set to `true`.
 *
 * It deliberately probes through `supports()` rather than reading `covers`
 * directly, so it tracks the renderer's own detector rather than a parallel
 * notion of coverage that could drift from it.
 */
describe('joining and RTL scripts', () => {
  /** One representative letter per script whose shaping our draw path cannot place. */
  const JOINING = {
    Arabic: 'ب',
    Hebrew: 'א',
    Syriac: 'ܐ',
    Thaana: 'ހ',
    NKo: 'ߊ',
  } as const;

  /**
   * The must-be-FOUND control, and it is the whole reason the assertion below
   * means anything. `supports()` returning false for every sample is the
   * evidence — and a probe that had stopped reading faces would return false for
   * everything, certifying the tree forever. Cyrillic IS covered, so this
   * separates "no face covers Arabic" from "the probe read no faces".
   */
  it('the coverage probe can see a script that is bundled', () => {
    expect(type.supports('Б')).toBe(true);
    expect(drawn('Б')).toBe('Б');
  });

  it('no bundled face covers a script the draw path cannot place', () => {
    const covered = Object.entries(JOINING)
      .filter(([, sample]) => type.supports(sample))
      .map(
        ([script]) =>
          `${script} is now covered by a bundled face, so the [?] mark no longer fires for it — ` +
          'but statement.ts still places runs in logical order. Implement visual run ordering ' +
          'and replace this test with the run-order assertion; do not delete it.'
      );
    expect(covered).toEqual([]);
  });

  /**
   * The state this guard exists to preserve, asserted positively rather than as
   * the absence of a complaint: an Arabic name is currently MARKED, so a reader
   * sees `[?]` and the metadata note rather than misordered text.
   */
  it('an Arabic name is marked today, not silently misplaced', () => {
    expect(type.supports('بنك')).toBe(false);
    expect(drawn('بنك ABC')).toBe(`${UNSUPPORTED_MARK} ABC`);
  });
});
