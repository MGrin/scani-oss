/// <reference path="./assets.d.ts" />
// The `declare module '*.woff'` this file needs reaches a program only if that
// program INCLUDES `assets.d.ts`. `apps/backend/api/tsconfig.json` does, via
// `src/**/*` — so the api's own type-check has always been green and the
// dependency was invisible. Any OTHER project that reaches this file through
// the import graph does not, and gets 17 x TS2307 naming modules that exist on
// disk: `scripts/tsconfig.json` includes `scripts/**/*.ts` and nothing else, so
// the first script to import the api router hit exactly that (SC-728).
//
// The reference is here rather than an entry in the other project's `include`
// because a declaration belongs with the file that cannot compile without it.
// Put in a config, it fixes one importer and waits for the next one.

import monoCyrillic from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-cyrillic-500-normal.woff' with {
  type: 'file',
};
import monoCyrillicExt from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-cyrillic-ext-500-normal.woff' with {
  type: 'file',
};
import monoLatin from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff' with {
  type: 'file',
};
import monoLatinExt from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-ext-500-normal.woff' with {
  type: 'file',
};
import monoVietnamese from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-vietnamese-500-normal.woff' with {
  type: 'file',
};
import sansCyrillic from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-400-normal.woff' with {
  type: 'file',
};
import boldCyrillic from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-600-normal.woff' with {
  type: 'file',
};
import sansCyrillicExt from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-ext-400-normal.woff' with {
  type: 'file',
};
import boldCyrillicExt from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-ext-600-normal.woff' with {
  type: 'file',
};
import sansGreek from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-greek-400-normal.woff' with {
  type: 'file',
};
import boldGreek from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-greek-600-normal.woff' with {
  type: 'file',
};
import sansLatin from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff' with {
  type: 'file',
};
import boldLatin from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff' with {
  type: 'file',
};
import sansLatinExt from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-ext-400-normal.woff' with {
  type: 'file',
};
import boldLatinExt from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-ext-600-normal.woff' with {
  type: 'file',
};
import sansVietnamese from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-vietnamese-400-normal.woff' with {
  type: 'file',
};
import boldVietnamese from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-vietnamese-600-normal.woff' with {
  type: 'file',
};
import hanJapanese from '@fontsource/noto-sans-jp/files/noto-sans-jp-japanese-400-normal.woff' with {
  type: 'file',
};
import hanSimplified from '@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff' with {
  type: 'file',
};
import * as fontkit from 'fontkit';
import type { Face } from './layout';

/**
 * Which face draws which character — SC-127.
 *
 * **The problem this module exists for.** Fontsource ships one file per unicode
 * range, and the statement embedded only the `latin` ones. `Ż` is Latin
 * Extended-A, `Сбербанк` is Cyrillic, and neither is in that file, so pdfkit
 * mapped every one of those characters to `.notdef` and drew an empty box —
 * silently, while the CSV beside it carried the same name correctly. A vendor's
 * name blanked out in a document sent to an accountant reads as *missing data*,
 * which is worse than no PDF at all.
 *
 * **Why a stack rather than a bigger font.** There is no single file to swap in.
 * The subsets are disjoint — `latin-ext` does not contain `A` — so covering more
 * scripts means embedding more files and choosing between them per character,
 * and it would mean the same thing with a vendored full TTF, because no IBM Plex
 * face covers CJK at all. So a *face stack* per role: an ordered list of files,
 * and every string is split into runs by which file is the first to cover each
 * character. All the files are cuts of the same typeface at the same weight, so
 * a run boundary inside a word is invisible; what crosses it is the kerning
 * pair, which at 9.5pt is not a thing anyone can see.
 *
 * **Han is covered as of SC-782, and only partly — on purpose.** `三菱UFJ銀行`
 * used to set as `[?]UFJ[?]`, legible in the CSV beside it and not in the PDF.
 * What blocked it in SC-127 was that Google ships Noto Sans JP and SC as
 * *variable* fonts (9.6 MB and 17.8 MB) which fontkit cannot instance — the
 * exact bug that produced a statement with no text at all in SC-94. Fontsource
 * publishes *static* per-subset cuts of the same faces, which removes that
 * blocker without removing the size one.
 *
 * The whole face still cannot be subsetted to the input, because the input is a
 * user-supplied merchant name. So this ships two frequency subsets rather than
 * four pan-CJK cuts, and the characters outside them keep exactly the behaviour
 * they have always had: {@link UNSUPPORTED_MARK}, per codepoint, plus the
 * metadata line. **That is what makes partial coverage safe here** — Han neither
 * joins nor reorders, so a gap degrades loudly and locally. It would not be safe
 * for a joining or RTL script, where what breaks is placement and no coverage
 * check can see it (SC-763).
 *
 * **Why these two files.** Measured coverage, from the same fontkit parse this
 * module uses: JP 6887 codepoints, SC 7947, union 10036 for 2.94 MB against a
 * 356 kB baseline of Plex subsets. JP is probed first: it and SC share 4798
 * codepoints, and where a character is in both, the Japanese cut carries the
 * glyph shapes a Japanese name should have.
 *
 * **Traditional Chinese is absent for a PRODUCT reason, not a size one, and the
 * distinction matters** (mgrin, 2026-08-28). The file is a third 1.36 MB, which
 * is immaterial to a Fly image and to cold start — if size were the only
 * argument the honest move would be to move the line, not to leave the gap.
 * SC-201 ships one Chinese locale, and whether zh-TW ever joins it is a call
 * this module does not get to make by quietly bundling a face for it. Tracked
 * separately; a Traditional-only character is marked meanwhile, loudly and per
 * codepoint, exactly like any other gap.
 *
 * **Neither file covers Hangul** — 0 codepoints, measured. Korean names are
 * still marked, which is a real gap and a deliberate one: Hangul is not Han.
 *
 * Adding a script later is adding files to {@link STACKS}; nothing else changes.
 */

/**
 * What a character that no embedded face can draw prints as.
 *
 * Deliberately not a box, and deliberately not a transliteration. A box is
 * indistinguishable from a blank cell, and transliterating a legal name in a
 * document that goes to a bank produces a name that is not the name. This is
 * short enough not to widen its column out of proportion — a run of them
 * collapses to one — and obviously a marker rather than data.
 */
export const UNSUPPORTED_MARK = '[?]';

type Source = readonly [name: string, path: string];

/**
 * Latin first, so the common case resolves on the first probe, then the ranges
 * a European name actually lands in. Order within the rest is immaterial: the
 * subsets do not overlap.
 */
const SANS: readonly Source[] = [
  ['Sans', sansLatin],
  ['Sans-Ext', sansLatinExt],
  ['Sans-Cyrillic', sansCyrillic],
  ['Sans-Cyrillic-Ext', sansCyrillicExt],
  ['Sans-Greek', sansGreek],
  ['Sans-Vietnamese', sansVietnamese],
];

const BOLD: readonly Source[] = [
  ['Bold', boldLatin],
  ['Bold-Ext', boldLatinExt],
  ['Bold-Cyrillic', boldCyrillic],
  ['Bold-Cyrillic-Ext', boldCyrillicExt],
  ['Bold-Greek', boldGreek],
  ['Bold-Vietnamese', boldVietnamese],
];

const MONO: readonly Source[] = [
  ['Mono', monoLatin],
  ['Mono-Ext', monoLatinExt],
  ['Mono-Cyrillic', monoCyrillic],
  ['Mono-Cyrillic-Ext', monoCyrillicExt],
  ['Mono-Vietnamese', monoVietnamese],
];

/**
 * Probed last, by every role. A Han lookup is rare and these two files are four
 * times the size of every Plex subset put together, so they sit behind the
 * ranges a European name actually lands in — and the Plex subsets carry no Han,
 * so nothing above can shadow them.
 *
 * JP before SC: the two share 4798 codepoints, and for a shared one the first
 * face wins, so this decides whose glyph shapes a mixed name gets. Japanese is
 * the case that motivated SC-782. Where a name is simplified-only — `银` is in
 * SC and not in JP — the second file covers it.
 *
 * The `-400-` files report `usWeightClass=400` and `subfamilyName=Regular`;
 * `fullName` reads `Noto Sans JP Thin Regular`, which is Fontsource's naming
 * artefact from instancing the variable source and NOT a thin cut. Measured
 * against the Plex baseline, which reads 400/Regular identically.
 */
const HAN: readonly Source[] = [
  ['Han-JP', hanJapanese],
  ['Han-SC', hanSimplified],
];

/**
 * Plex Mono has no Greek cut, and a figure column can hold a text cell. Falling
 * through to Sans there sets one cell in the wrong face; refusing to would print
 * a marker over a name that is perfectly renderable. The mono columns this
 * document has are money and dates, so nothing that reaches Sans here was ever
 * going to line up on a decimal point.
 *
 * `bold` reaches the same regular-weight Han files rather than a 600 cut of its
 * own, and that is the same trade one line up: a group heading with a Japanese
 * name set in regular weight is a smaller loss than one replaced by a marker.
 * It also costs nothing — faces are loaded and registered by NAME, so a file
 * named in two stacks is one buffer and one embedded font, not two.
 */
const STACKS: Record<Face, readonly Source[]> = {
  sans: [...SANS, ...HAN],
  bold: [...BOLD, ...HAN],
  mono: [...MONO, ...SANS, ...HAN],
};

export interface Run {
  /** The name the face is registered under on the document. */
  font: string;
  text: string;
}

interface LoadedFace {
  name: string;
  bytes: Buffer;
  covers: Set<number>;
}

export interface Typesetter {
  /**
   * The face pdfkit must be *constructed* with. Its default is Helvetica, whose
   * metrics it reads from a `node_modules` path that does not exist in the
   * runtime image, so the first export in production throws ENOENT while every
   * local run passes (SC-129).
   */
  readonly primary: Buffer;
  register(doc: PDFKit.PDFDocument): PDFKit.PDFDocument;
  /** `text` split into the longest runs that share one face. */
  shape(text: string, face: Face): Run[];
  /** Whether every character in `text` has a face — i.e. nothing was replaced. */
  supports(text: string): boolean;
}

let cached: Typesetter | null = null;

/**
 * Loaded once and kept. Seventeen files at ~200 kB together, embedded in the
 * compiled binary by Bun's `type: 'file'` imports — the runtime image has no
 * `node_modules`, so reading them from a package path would work in dev and fail
 * in production, which is the sort of difference only a deploy finds.
 *
 * The coverage sets come from fontkit, which is what pdfkit embeds fonts
 * through, so what this module believes a face can draw and what pdfkit
 * actually draws come from the same parse of the same bytes.
 */
export async function loadTypesetter(): Promise<Typesetter> {
  if (cached) return cached;

  const paths = new Map<string, string>();
  for (const stack of Object.values(STACKS)) {
    for (const [name, path] of stack) paths.set(name, path);
  }

  const faces = new Map<string, LoadedFace>();
  await Promise.all(
    [...paths].map(async ([name, path]) => {
      const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
      const font = fontkit.create(bytes);
      // `create` also answers with a collection, for a `.ttc` or a `.dfont`.
      // These are single-face `.woff`s from a pinned package, so that branch is
      // unreachable — but reading `characterSet` off a collection yields
      // `undefined`, an empty coverage set, and a statement in which *every*
      // character is unsupported. Loud beats that.
      if (!('characterSet' in font))
        throw new Error(`pdf font ${name} is a collection, not a face`);
      faces.set(name, { name, bytes, covers: new Set(font.characterSet) });
    })
  );

  const stacks = Object.fromEntries(
    Object.entries(STACKS).map(([face, sources]) => [
      face,
      sources.map(([name]) => faces.get(name) as LoadedFace),
    ])
  ) as Record<Face, LoadedFace[]>;

  cached = {
    primary: (faces.get('Sans') as LoadedFace).bytes,
    register(doc) {
      for (const face of faces.values()) doc.registerFont(face.name, face.bytes);
      return doc;
    },
    shape(text, face) {
      return shape(text, stacks[face]);
    },
    supports(text) {
      return [...text].every((character) =>
        stacks.sans.some((face) => face.covers.has(character.codePointAt(0) as number))
      );
    },
  };
  return cached;
}

function shape(text: string, stack: readonly LoadedFace[]): Run[] {
  const runs: Run[] = [];
  const fallback = stack[0] as LoadedFace;
  let marked = false;

  const push = (font: string, piece: string): void => {
    const last = runs[runs.length - 1];
    if (last?.font === font) last.text += piece;
    else runs.push({ font, text: piece });
  };

  // Iterated by code point, not by unit, so an astral character is one decision
  // rather than two halves of one that no face claims.
  for (const character of text) {
    const point = character.codePointAt(0) as number;
    const hit = stack.find((face) => face.covers.has(point));
    if (hit) {
      marked = false;
      push(hit.name, character);
      continue;
    }
    // A run of unrepresentable characters collapses to a single marker. Six of
    // them in a row is not six times as much information as one, and printing
    // six would make the name three times wider than it is.
    if (marked) continue;
    marked = true;
    push(fallback.name, UNSUPPORTED_MARK);
  }

  return runs;
}
