import { describe, expect, it } from 'bun:test';
import * as fontkit from 'fontkit';
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

/**
 * The bytes of every face, by the name runs are labelled with. `register` is the
 * only way in — it hands each face to a document — so a fake document collects
 * them without the module needing a second accessor that only tests would use.
 */
const embedded = ((): Map<string, Buffer> => {
  const bytes = new Map<string, Buffer>();
  type.register({
    registerFont: (name: string, data: Buffer) => bytes.set(name, data),
  } as unknown as PDFKit.PDFDocument);
  return bytes;
})();

/**
 * Codepoints no bundled face covers — DERIVED, never named (SC-782).
 *
 * Three assertions below use "a character nothing covers" as their subject, and
 * every one of them used to spell that as a CJK or Hangul literal. That was
 * true when written and is an accident of what was bundled: the moment a Han
 * face landed, two of those samples became covered and the tests started
 * asserting the opposite of what their names say. The third, `한국투자증권`,
 * did NOT — Hangul is not Han, and neither bundled face carries a single
 * Hangul codepoint (measured 0) — so it survived the change reading as
 * unaffected, which is the worse failure of the two.
 *
 * So the sample is found by asking the typesetter, at the time the test runs.
 * Han is swept first, because a gap inside an otherwise-covered script is the
 * sharper subject and keeps these tests' original character; the other ranges
 * are there so a future face that covered all of Han could not silently empty
 * this list.
 *
 * The search asserts nothing itself. `finds a codepoint no bundled face covers`
 * is the must-be-FOUND control for it — without that, a sweep that found
 * nothing and a tree with no defect read identically.
 */
const SWEEP: readonly (readonly [number, number])[] = [
  [0x20000, 0x2a6df], // CJK Extension B — Han, and rare enough to stay out of any frequency subset
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xac00, 0xd7af], // Hangul syllables — not Han, so covered by nothing here today
  [0x0530, 0x058f], // Armenian, as a non-CJK backstop
];

function uncovered(count: number): string[] {
  const found: string[] = [];
  for (const [from, to] of SWEEP) {
    for (let point = from; point <= to && found.length < count; point += 1) {
      const character = String.fromCodePoint(point);
      if (!type.supports(character)) found.push(character);
    }
    if (found.length >= count) break;
  }
  return found;
}

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

  it('finds a codepoint no bundled face covers', () => {
    // The must-be-FOUND control for `uncovered`. The three assertions below are
    // about what happens to an unrepresentable character, so a sweep that
    // quietly returned nothing would leave them asserting on empty strings and
    // passing. If this ever reds, it is interesting: it means every codepoint
    // swept is covered, and these tests have lost their subject rather than
    // their correctness.
    expect(uncovered(6)).toHaveLength(6);
  });

  it('marks what no face covers instead of drawing a box', () => {
    const [first, second] = uncovered(2) as [string, string];
    const name = `${first}UFJ${second}`;
    expect(drawn(name)).toBe(`${UNSUPPORTED_MARK}UFJ${UNSUPPORTED_MARK}`);
    expect(type.supports(name)).toBe(false);
  });

  it('collapses a run of unsupported characters to one mark', () => {
    // Six marks is not six times the information of one, and it would set the
    // name three times wider than it is.
    const run = uncovered(6).join('');
    expect([...run]).toHaveLength(6);
    expect(drawn(run)).toBe(UNSUPPORTED_MARK);
  });

  it('draws the mark in a face the document already has', () => {
    const [sample] = uncovered(1) as [string];
    expect(faces(sample)).toEqual(['Sans']);
    expect(faces(sample, 'bold')).toEqual(['Bold']);
  });

  it('sets Han in a Han face rather than marking it', () => {
    // The inversion of the three above, and the reason they had to move: Han is
    // covered as of SC-782, so it is no longer a stand-in for `uncovered`.
    expect(drawn('三菱UFJ銀行')).toBe('三菱UFJ銀行');
    expect(type.supports('三菱UFJ銀行')).toBe(true);
    expect(faces('三菱UFJ銀行')).toEqual(['Han-JP', 'Sans', 'Han-JP']);
  });

  it('resolves Han to real glyphs in the face it names, not to .notdef', () => {
    // `supports()` and a non-empty PDF both pass on a tree where the glyphs are
    // wrong: coverage is a claim about a character set, and what actually gets
    // drawn is a glyph id. So this asks the embedded bytes — the same bytes
    // pdfkit is handed — what each Han codepoint resolves to. Glyph 0 is
    // `.notdef`, which is the empty box this whole module exists to prevent.
    const runs = type.shape('三菱', 'sans');
    expect(runs).toHaveLength(1);
    const bytes = embedded.get(runs[0]?.font as string);
    expect(bytes).toBeDefined();
    const face = fontkit.create(bytes as Buffer);
    expect('characterSet' in face).toBe(true);

    for (const character of '三菱銀行') {
      const glyph = (face as fontkit.Font).glyphForCodePoint(character.codePointAt(0) as number);
      expect(glyph.id).toBeGreaterThan(0);
    }
  });

  it('control — the glyph probe reads a real face, so a zero would mean something', () => {
    // Without this, "every Han codepoint resolved" and "the probe read a face
    // with no glyphs in it" are the same reading. A codepoint the face is known
    // to cover must resolve, and one it cannot must not.
    const bytes = embedded.get('Han-JP') as Buffer;
    const face = fontkit.create(bytes) as fontkit.Font;
    expect(face.numGlyphs).toBeGreaterThan(1000);
    expect(face.glyphForCodePoint('三'.codePointAt(0) as number).id).toBeGreaterThan(0);
    const [missing] = uncovered(1) as [string];
    expect(face.glyphForCodePoint(missing.codePointAt(0) as number).id).toBe(0);
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
 * THE RUN-ORDER ASSERTION THAT LIFTS SC-763's REFUSAL (SC-968).
 *
 * SC-763 refused coverage for a joining or right-to-left script and named its
 * own price: *"REPLACE THIS TEST WITH THE RUN-ORDER ASSERTION — that a mixed
 * RTL/LTR line is drawn in visual order — and make it pass."* That assertion is
 * `bidi.test.ts`, and this block is what connects it to a real page.
 *
 * **The refusal is gone rather than weakened, and that is the point.** It was
 * an implication with a measured antecedent — coverage — and a consequent that
 * cost writing the ordering. The ordering is written; there was never anything
 * here to set to `true`.
 *
 * What replaces it is narrower and mechanical: the two facts `bidi.ts` rests on
 * that are properties of the FONTS rather than of our code, so a face bundled
 * by SC-201 could falsify either one without touching a line of the renderer.
 */
describe('what the run ordering assumes about the faces', () => {
  /**
   * fontkit reverses the glyphs of a run it reads as right-to-left, and
   * `bidi.ts` relies on that: it orders the RUNS and leaves the characters
   * inside each one alone. Doing both would undo one.
   *
   * The instrument is a face that covers NONE of these scripts, which is the
   * only kind this repo has — and it works because fontkit takes the direction
   * from the text's own script, never from the font. That is the whole claim,
   * and it is exactly what makes it assertable here.
   */
  it('fontkit reads direction from the text, not from the font', () => {
    const plex = fontkit.create(embedded.get('Sans') as Buffer);
    if (!('layout' in plex)) throw new Error('Sans is a collection, not a face');

    expect(plex.layout('بنك').direction).toBe('rtl');
    expect(plex.layout('בנק').direction).toBe('rtl');

    // The must-be-LTR controls. Without them a `direction` stuck at `rtl` would
    // satisfy the two assertions above and say nothing.
    expect(plex.layout('ABC').direction).toBe('ltr');
    expect(plex.layout('Сбербанк').direction).toBe('ltr');
  });

  /**
   * And the case `bidi.ts` has to handle itself, asserted rather than reasoned
   * about: a run of nothing but neutrals has no strong character to detect a
   * script from, so fontkit calls it left-to-right and leaves it in logical
   * order even at an odd embedding level. That is why `drawnText` reverses
   * exactly those runs and no others.
   */
  it('leaves a run of neutrals left-to-right, whatever its level', () => {
    const plex = fontkit.create(embedded.get('Sans') as Buffer);
    if (!('layout' in plex)) throw new Error('Sans is a collection, not a face');

    expect(plex.layout(' (').direction).toBe('ltr');
    expect(plex.layout('1,234.50').direction).toBe('ltr');
  });

  /**
   * `bidi.ts` applies rule L4 — mirroring a bracket at an odd level — itself,
   * because leaving it to the `rtlm` OpenType feature would make the output
   * depend on which face happened to be bundled. fontkit DOES enable `rtlm` for
   * a right-to-left run, so a face that defined it would mirror a second time
   * and turn `'(ABC) بنك'` back into `')ABC( بنك'`.
   *
   * No face declares it today, and none of the Arabic faces on the machine this
   * was measured on does either — mirroring is the layout engine's job in
   * practice, not the font's. This is the one-command check SC-201 owes when it
   * bundles one, expressed as a test so that nobody has to remember to run it.
   */
  it('no bundled face declares rtlm, so the mirroring is not applied twice', () => {
    const declaring: string[] = [];
    let readable = 0;
    for (const [name, bytes] of embedded) {
      const face = fontkit.create(bytes);
      if (!('availableFeatures' in face)) throw new Error(`${name} is a collection, not a face`);
      if (face.availableFeatures.length > 0) readable += 1;
      if (face.availableFeatures.includes('rtlm')) declaring.push(name);
    }

    // The must-be-FOUND control, and it is global rather than per face for a
    // reason this control found itself: `Mono-Cyrillic-Ext` reports an EMPTY
    // feature list, and that is the truth about it rather than a failed read —
    // a subset with no layout tables declares nothing, and so cannot declare
    // `rtlm` either. A per-face floor would fail on it while a reader that had
    // gone blind everywhere would still pass this. `kern` was the first choice
    // and is not universal here: one cut declares only `ccmp` and `mark`.
    expect(readable).toBeGreaterThan(0);
    expect(declaring).toEqual([]);
  });
});

/**
 * WHY THE RUN-ORDER ASSERTION CANNOT BE MADE ON A DOCUMENT (SC-968).
 *
 * Kept from SC-763, and it has changed job. It used to be the positive
 * statement of the state that guard preserved. It is now the reason
 * `bidi.test.ts` asserts on `visualRuns` and not on a rendered page: there is
 * no string a statement can draw today that resolves to an odd embedding level,
 * so a document-level assertion would be an assertion about `[?]`.
 *
 * It is also the thing SC-201 changes. When these expectations flip, the
 * ordering is what stands between a reader and a misplaced name.
 */
describe('no right-to-left character can reach the page today', () => {
  /**
   * The must-be-FOUND control. `supports()` returning false for everything
   * would satisfy every assertion below while reading no faces at all.
   */
  it('the coverage probe can see a script that is bundled', () => {
    expect(type.supports('Б')).toBe(true);
    expect(drawn('Б')).toBe('Б');
  });

  it('an Arabic name is marked, so a mixed line is pure ASCII', () => {
    expect(type.supports('بنك')).toBe(false);
    expect(drawn('بنك ABC')).toBe(`${UNSUPPORTED_MARK} ABC`);
  });

  /** One representative letter per script whose placement the ordering now
   *  handles but whose glyphs are still not bundled. */
  it('nor does any other joining or right-to-left script', () => {
    for (const sample of ['ب', 'א', 'ܐ', 'ހ', 'ߊ']) {
      expect(type.supports(sample)).toBe(false);
    }
  });

  /**
   * And no directional control character either, which is the arm that would
   * otherwise be missed: RLO or RLE alone is enough to force an odd level out
   * of ordinary Latin text, without any RTL script being covered at all.
   */
  it('nor any character that could force a direction on its own', () => {
    for (const control of ['‏', '؜', '‫', '‮', '⁧']) {
      expect(type.supports(control)).toBe(false);
    }
  });
});
