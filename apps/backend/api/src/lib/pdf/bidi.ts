/// <reference path="./bidi-js.d.ts" />
// Same reason `fonts.ts` carries one for `assets.d.ts`: a declaration belongs
// with the file that cannot compile without it. Put in a tsconfig `include`
// instead, it fixes one importer and waits for the next one (SC-728).

import bidiFactory from 'bidi-js';
import type { Run } from './fonts';

/**
 * Which run is drawn where — SC-968.
 *
 * **The defect this exists for.** `statement.ts` draws each run at an explicit
 * x and advances left to right, unconditionally. That is the whole of its
 * placement logic and it is correct for every script it can currently draw.
 * Bundle a face for Arabic or Hebrew and it stops being: the *glyphs* would be
 * right — fontkit 2.0.4 ships `ArabicShaper.js` and pdfkit calls
 * `font.layout()` — but the RUNS would still be emitted in logical order, so
 * `'بنك ABC'` sets with the Arabic on the left and the Latin on the right,
 * which is the reverse of what it says. Correct letters, wrong half of the
 * cell, and no `[?]` to say so, because coverage is exactly what stops
 * `supports()` firing (`fonts.ts`).
 *
 * **What this does and does not own.** Ordering *within* a run is fontkit's and
 * is already right: it picks the run direction from the text's first strong
 * character — never from the font — and reverses the glyphs of a run it reads
 * as RTL. Measured against Arial Unicode as an instrument: `'بنك'` is
 * codepoints `628 646 643` in logical order and lays out `643 | 646 | 628`,
 * against a `'ABC'` control that comes back `41 42 43` unreversed. So what is
 * missing is the order runs are placed IN, and that is all this module
 * decides.
 *
 * **Why `bidi-js` rather than a subset written here.** The easy half of the
 * Unicode Bidirectional Algorithm is the reordering (rule L2, below, ~20
 * lines). The hard half is resolving the levels — the weak types (W1-W7) and
 * the neutrals (N0-N2) — and those rules are about exactly what a *statement*
 * is full of: digits, separators, currency symbols and brackets sitting
 * between two directions. `'بنك -1,234.50'` resolves the minus and the digits
 * to three different levels, and getting that wrong moves a number rather than
 * making the page look odd. Hand-rolling it means hand-rolling the
 * `Bidi_Class` table too, and then having no conformance data to check it
 * against. Measured before taking it: MIT, 43 kB as ESM and 11.9 kB minified,
 * and its one declared dependency (`require-from-string`) appears nowhere in
 * its `dist/` or `src/` — a phantom, so the real transitive surface is zero.
 *
 * **What is NOT implemented, stated rather than left to be discovered.**
 * Explicit directional overrides and isolates are resolved by `bidi-js` (rules
 * X1-X10) but nothing here or upstream of it *emits* them, so that path is
 * carried, not exercised. Vertical text, line breaking and rule L1's
 * segment-separator reset are not relevant: `put` never wraps and draws one
 * line at a time, so every string here is a whole paragraph.
 */

const bidi = bidiFactory();

interface Placed extends Run {
  level: number;
}

/**
 * Runs in the order they are DRAWN, left to right.
 *
 * Takes the runs `Typesetter.shape` produced rather than the original string,
 * because those are not the same text: an unsupported character has already
 * become `UNSUPPORTED_MARK` by then, and levels resolved against the original
 * would be indexed against characters that are not on the page. Resolving
 * against what is actually drawn is also the more useful answer — today every
 * RTL character IS a marker, so a mixed line is pure ASCII and this correctly
 * leaves it alone.
 */
export function visualRuns(runs: readonly Run[]): Run[] {
  const text = runs.map((run) => run.text).join('');
  const { levels } = bidi.getEmbeddingLevels(text);

  let highest = 0;
  let lowestOdd = Number.POSITIVE_INFINITY;
  for (const level of levels) {
    if (level > highest) highest = level;
    if (level % 2 === 1 && level < lowestOdd) lowestOdd = level;
  }

  // Nothing resolved to an odd level, so logical order IS visual order. This is
  // the path every Latin, Cyrillic, Greek and Han statement takes, and it must
  // hand back the runs unchanged rather than an equivalent-looking rebuild:
  // `runsWidth` charges tracking per run boundary, so changing the run COUNT
  // changes the measured width of a line nobody asked to move.
  if (lowestOdd === Number.POSITIVE_INFINITY) return [...runs];

  let placed = atLevels(runs, levels);
  // Rule L2, on runs rather than on characters — see `drawnText` for why the
  // difference is load-bearing. From the highest level down to the lowest odd
  // one, including levels not actually present, reverse every contiguous
  // sequence at that level or above. A level-2 run inside level-0 text is
  // reversed twice and lands back where it started, which is how `'abc 123'`
  // survives an algorithm that gives its digits a level of their own.
  for (let level = highest; level >= lowestOdd; level -= 1) placed = reversed(placed, level);
  return placed.map((piece) => ({ font: piece.font, text: drawnText(piece) }));
}

/** The face runs cut again wherever the resolved level changes, so that every
 *  piece is uniform in both — one face, one direction. */
function atLevels(runs: readonly Run[], levels: Uint8Array): Placed[] {
  const placed: Placed[] = [];
  let at = 0;
  for (const run of runs) {
    let start = 0;
    for (let index = 1; index <= run.text.length; index += 1) {
      if (index < run.text.length && levels[at + index] === levels[at + start]) continue;
      placed.push({
        font: run.font,
        text: run.text.slice(start, index),
        level: levels[at + start] as number,
      });
      start = index;
    }
    at += run.text.length;
  }
  return placed;
}

/** One pass of rule L2: reverse each contiguous sequence of runs at `level` or
 *  above, in place on the order the previous pass left. */
function reversed(placed: readonly Placed[], level: number): Placed[] {
  const out = [...placed];
  let start = -1;
  for (let index = 0; index <= out.length; index += 1) {
    if (index < out.length && (out[index] as Placed).level >= level) {
      if (start < 0) start = index;
      continue;
    }
    for (let low = start, high = index - 1; start >= 0 && low < high; low += 1, high -= 1) {
      const swap = out[low] as Placed;
      out[low] = out[high] as Placed;
      out[high] = swap;
    }
    start = -1;
  }
  return out;
}

/**
 * The characters of one run, as they must reach pdfkit.
 *
 * **Two things happen at an odd level and only one of them is ours.** Rule L2
 * reverses the characters as well as the runs, and fontkit already does that —
 * for a run it reads as RTL. It reads direction from the first STRONG
 * character and from nothing else (measured: a Latin-only face still reports
 * `direction=rtl` for Arabic and Hebrew text and `ltr` for Latin), so a run of
 * nothing but neutrals — the `' ('` that sits between an Arabic word and a
 * Latin one — comes back `ltr` and is left in logical order. That one is ours,
 * and it is the difference between `')ABC( كنب'` and `')ABC ( كنب'`. Reversing
 * a run fontkit will also reverse would undo it, so the test is exactly "will
 * fontkit not".
 *
 * **Rule L4, mirroring, is applied here and not left to the font.** A bracket
 * at an odd level is drawn as its mirror, so `'شركة (ABC)'` keeps its brackets
 * around the Latin rather than turned inside out. Mirroring the source
 * characters composes with fontkit's reversal because it is per-character, so
 * the order the two happen in does not matter. It is done here rather than by
 * the `rtlm` OpenType feature — which fontkit does enable for RTL runs —
 * because `rtlm` is something a FONT may or may not define, so leaving it to
 * the font makes the output depend on which face is bundled. Measured: neither
 * bundled face declares `rtlm` (control: both declare `kern`), and neither does
 * a real Arabic face on this machine. `fonts.test.ts` fails if that ever stops
 * being true, because a face that DID define it would mirror a second time.
 */
function drawnText(piece: Placed): string {
  if (piece.level % 2 === 0) return piece.text;
  const characters = [...piece.text].map((character) => mirrored(character));
  if (!hasStrongRtl(piece.text)) characters.reverse();
  return characters.join('');
}

function mirrored(character: string): string {
  return bidi.getMirroredCharacter(character) ?? character;
}

/** Whether fontkit will read this run as RTL and reverse it for us — which is
 *  the same question as whether it contains a strong right-to-left character,
 *  because that is what fontkit's own script detection looks for. */
function hasStrongRtl(text: string): boolean {
  for (const character of text) {
    const type = bidi.getBidiCharTypeName(character);
    if (type === 'R' || type === 'AL') return true;
  }
  return false;
}
