import { describe, expect, it } from 'bun:test';
import bidiFactory from 'bidi-js';
import { visualRuns } from '../../../src/lib/pdf/bidi';
import type { Run } from '../../../src/lib/pdf/fonts';
import { TYPE, truncate } from '../../../src/lib/pdf/layout';

/**
 * The order runs are drawn in — SC-968.
 *
 * **Why these assertions are on `visualRuns` and not on a rendered page.** They
 * would rather be on a page. They cannot be, and the reason is the ticket:
 * `supports()` is pure codepoint coverage, so the day an Arabic face is
 * bundled is the day the `[?]` detector stops firing, and SC-763 therefore
 * refuses the face until this ordering exists. Measured rather than assumed —
 * no bundled face covers Arabic or Hebrew, and none covers RLM, RLO, RLE, ALM
 * or the isolates either (`fonts.test.ts`) — so there is no string a real
 * statement can draw today that resolves to an odd embedding level. Asserting
 * on a document would be asserting on the ASCII `[?]` it degrades to.
 *
 * So the runs are built the way the typesetter WILL build them once a face
 * lands, and the two facts that bridge from here to a real page are pinned
 * separately in `fonts.test.ts`: that fontkit reverses exactly the runs it
 * reads as right-to-left, and that no bundled face declares `rtlm`.
 */

/** The face split a bundled Arabic face would produce: Arabic characters take
 *  the Arabic cut, everything else stays on Plex — including the SPACE, which
 *  the Latin subset covers and which is probed first. That is `shape`'s own
 *  rule, so a two-word Arabic name really does arrive as three runs. */
function shaped(text: string): Run[] {
  const runs: Run[] = [];
  for (const character of text) {
    const point = character.codePointAt(0) as number;
    const font = point >= 0x0600 && point <= 0x06ff ? 'Sans-Arabic' : 'Sans';
    const last = runs[runs.length - 1];
    if (last?.font === font) last.text += character;
    else runs.push({ font, text: character });
  }
  return runs;
}

const order = (text: string): string[] => visualRuns(shaped(text)).map((run) => run.text);

/** What ends up on the line, left to right, ignoring where the face changes.
 *  Characters inside a right-to-left run still read LOGICALLY here — fontkit
 *  reverses those glyphs, and doing it twice would undo it. */
const line = (text: string): string => order(text).join('');

describe('visualRuns', () => {
  /**
   * The must-be-FOUND control, and the reason every "unchanged" assertion below
   * is a reading rather than the output of a function that reorders nothing. A
   * `visualRuns` reduced to the identity would satisfy every left-to-right case
   * in this file and fail only here.
   */
  it('reorders a mixed line at all', () => {
    expect(order('بنك ABC')).not.toEqual(['بنك', ' ABC']);
    expect(order('بنك ABC')).toEqual(['ABC', ' ', 'بنك']);
  });

  describe('text that has no right-to-left character is untouched', () => {
    it('leaves a Latin line in logical order', () => {
      expect(order('Vanguard FTSE All-World')).toEqual(['Vanguard FTSE All-World']);
    });

    it('leaves a Cyrillic line in logical order', () => {
      expect(order('Сбербанк')).toEqual(['Сбербанк']);
    });

    /**
     * The regression this one guards is subtle enough to be worth its own test.
     * Rule I1 gives European digits in left-to-right text an embedding level of
     * their OWN — 2, not 0 — so a reordering that reversed "every run above the
     * base level" would set `1,234.50` as `05.432,1` on a page that has never
     * contained a right-to-left character. Rule L2 saves it by reversing twice,
     * and the early exit here never gets that far: with no odd level present
     * there is nothing to reorder.
     */
    it('does not disturb an amount in a Latin line', () => {
      expect(order('Total 1,234.50 EUR')).toEqual(['Total 1,234.50 EUR']);
      expect(order('1,234.50 EUR')).toEqual(['1,234.50 EUR']);
      expect(order('-1,234.50')).toEqual(['-1,234.50']);
    });

    /** Hands back the SAME number of runs, not an equal-looking rebuild.
     *  `runsWidth` charges tracking once per run BOUNDARY, so a split that
     *  changed the run count would change the measured width of a tracked
     *  column header that nobody asked to move. */
    it('preserves the run count exactly', () => {
      const runs = shaped('Kraken · Main');
      expect(visualRuns(runs)).toHaveLength(runs.length);
    });
  });

  describe('a right-to-left line', () => {
    it('places a trailing Latin word to the LEFT of the Arabic', () => {
      expect(order('بنك ABC')).toEqual(['ABC', ' ', 'بنك']);
    });

    it('places a leading Latin word to the left, where it already was', () => {
      expect(order('ABC بنك')).toEqual(['ABC ', 'بنك']);
    });

    it('leaves a single Arabic word as one run', () => {
      expect(order('مصر')).toEqual(['مصر']);
    });

    /**
     * Two Arabic words arrive as three runs — the space is covered by the Latin
     * subset, which is probed first — and their ORDER reverses while the
     * characters inside each stay logical for fontkit. Read right to left the
     * page says `بنك` then `مصر`, which is what was typed.
     */
    it('reverses the word order of a wholly Arabic line', () => {
      expect(order('بنك مصر')).toEqual(['مصر', ' ', 'بنك']);
    });

    /**
     * The money case, and the one that decided the dependency. An amount inside
     * an Arabic line resolves to a level of its own and must keep its digits in
     * reading order while moving to the other end of the line. Reversing the
     * characters of every odd-level run — the obvious hand-rolled shortcut —
     * places the run correctly and prints `05.432,1`.
     */
    it('moves an amount without reversing its digits', () => {
      expect(line('بنك 1,234.50')).toBe('1,234.50 بنك');
    });

    /**
     * **The minus lands to the RIGHT of the digits, and that is the algorithm's
     * answer rather than a defect here.** A leading `-` is a neutral between a
     * strong right-to-left letter and a number, so rule N2 gives it the
     * paragraph's own level and it stays with the Arabic. Cross-checked against
     * `getReorderedString` below, and it is the reason a formatter that means
     * the sign to travel with the figure emits a directional mark rather than
     * relying on position.
     *
     * It does not reach a numeric column, which is the only place this document
     * puts a signed figure: that cell holds the number and nothing else, so it
     * has no strong right-to-left character, and it takes the early exit above.
     */
    it('gives a bare minus to the paragraph, not to the number', () => {
      expect(line('بنك -1,234.50')).toBe('1,234.50- بنك');
    });
  });

  describe('neutral characters', () => {
    /**
     * Rule L4. A bracket at an odd level is drawn as its mirror, so the Latin
     * stays inside its brackets instead of being turned inside out. Without it
     * this line sets as `)ABC( بنك`, which is not a typographic nicety — it is
     * a different string.
     */
    it('mirrors brackets around a Latin word inside an Arabic line', () => {
      expect(line('بنك (ABC)')).toBe('(ABC) بنك');
    });

    /**
     * The half of rule L2 that fontkit cannot do for us. It picks a run's
     * direction from the first STRONG character, so a run of nothing but
     * neutrals comes back left-to-right and is left in logical order — and the
     * space that separated the Arabic from the bracket would end up on the
     * wrong side of it. The assertion is the space: `') '` and not `' )'`.
     */
    it('reverses a run that is neutral all the way through', () => {
      expect(order('بنك (ABC)')).toEqual(['(', 'ABC', ') ', 'بنك']);
    });
  });

  /**
   * **The independent instrument.** Everything above is a hand-written
   * expectation, and two of them were wrong on the first run in the direction
   * that would have shipped a bug. `bidi-js` also implements rules L2 and L4
   * itself, at the CHARACTER level, in `getReorderedString` — a function
   * `bidi.ts` deliberately never calls, because a character-level reorder would
   * be undone by fontkit reversing the same run a second time. Running the two
   * against each other is therefore a real cross-check of the reordering, not a
   * function agreeing with itself.
   *
   * **What it does NOT check**: both sides take their levels from the same
   * `getEmbeddingLevels`, so nothing here says the WEAK and NEUTRAL resolution
   * (rules W1-W7, N0-N2) is right — that is the half taken on the dependency's
   * authority, and taking it is why the dependency is there.
   *
   * The simulation of fontkit is one line and is exactly what was measured of
   * it: reverse the characters of a run that contains a strong right-to-left
   * character, and leave every other run alone.
   */
  describe('agrees with a character-level reordering of the same string', () => {
    const bidi = bidiFactory();
    const strongRtl = (text: string): boolean =>
      [...text].some((character) => ['R', 'AL'].includes(bidi.getBidiCharTypeName(character)));

    const asFontkitWouldDraw = (text: string): string =>
      order(text)
        .map((run) => (strongRtl(run) ? [...run].reverse().join('') : run))
        .join('');

    const reference = (text: string): string =>
      bidi.getReorderedString(text, bidi.getEmbeddingLevels(text));

    const samples = [
      'Vanguard FTSE All-World',
      'Сбербанк',
      'Total 1,234.50 EUR',
      'بنك',
      'بنك مصر',
      'بنك ABC',
      'ABC بنك',
      'بنك 1,234.50',
      'بنك -1,234.50',
      'بنك (ABC)',
      'شركة ABC للتجارة',
      'בנק ABC',
      'Kraken · بنك مصر · Main',
    ];

    /** The must-be-FOUND control for the loop below. Without it a `reference`
     *  that had started returning its argument unchanged would agree with a
     *  `visualRuns` that did nothing, and thirteen assertions would pass over
     *  two broken functions. */
    it('the reference reorders something', () => {
      expect(reference('بنك ABC')).not.toBe('بنك ABC');
      expect(reference('Vanguard FTSE All-World')).toBe('Vanguard FTSE All-World');
    });

    for (const sample of samples) {
      it(`matches for ${JSON.stringify(sample)}`, () => {
        expect(asFontkitWouldDraw(sample)).toBe(reference(sample));
      });
    }
  });

  /**
   * SC-968's own description says `truncate()` "cuts the trailing edge in the
   * LTR sense; under RTL that is the wrong end of the string". It is not: the
   * ellipsis is a neutral, so rule N2 resolves it to the paragraph's base level
   * and it lands at the visual LEFT of a right-to-left line without `truncate`
   * knowing anything about direction. Cutting the LOGICAL tail is correct for
   * both directions, and this is what says so.
   */
  describe('truncation composes with ordering, and needs no direction of its own', () => {
    const width = (text: string): number => text.length;

    it('puts the ellipsis at the visual left of a right-to-left line', () => {
      const cut = truncate('بنك مصر الوطني', 8, TYPE.rowText, width);
      expect(cut).toBe('بنك مصر…');
      expect(order(cut)[0]).toBe('…');
    });

    it('puts it at the visual right of a left-to-right line — the control', () => {
      const cut = truncate('Vanguard FTSE All-World', 8, TYPE.rowText, width);
      expect(cut).toBe('Vanguar…');
      expect(order(cut).at(-1)).toBe('Vanguar…');
    });
  });
});
