import { describe, expect, test } from 'bun:test';
import { commentSkipper } from '../../../../../packages/frontend/ui/tests/helpers/source-scan';
import { readV3Source, v3Sources } from './helpers/v3-sources';

/**
 * The two ways the desktop layout broke, made un-repeatable.
 *
 * V3-37 landed because six screens each hard-coded their own measure and none
 * of them had a desktop counterpart, so the widest monitor rendered a phone
 * column in the middle of an empty window. Both checks below are text scans
 * rather than render assertions, for the same reason `token-hygiene.test.ts`
 * is: each failure type-checks, lints and renders — it is only *wrong*, and on
 * a screen size nobody developing on a laptop looks at.
 */
const files = v3Sources();

describe('v3 page measure', () => {
  /**
   * `PageLayout` is the only file allowed to name a page width. Anywhere else,
   * a `max-w-[…]` on a full-width container is a seventh number that agrees
   * with the other six until someone changes one of them.
   *
   * The *pair* is what makes it a page measure: `mx-auto` plus a cap is a
   * centred column, and that is the shape being centralised. A `max-w-` on
   * something inside a page — a paragraph, a chip, a truncating cell — is not
   * this, and is deliberately not matched.
   */
  test('no screen centres its own column', async () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.name === 'components/PageLayout.tsx') continue;
      const text = await Bun.file(file.path).text();
      // Prose about a class name is not a use of it — every fix here left a
      // comment behind naming the thing it removed. One skipper per FILE: the
      // block state must not leak across files (SC-783).
      const isComment = commentSkipper();
      text.split('\n').forEach((line, index) => {
        if (isComment(line)) return;
        if (/\bmx-auto\b/.test(line) && /\bmax-w-\[/.test(line)) {
          offenders.push(`${file.name}:${index + 1} — ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Below `lg` every measure has to still be the phone layout — that is the
   * whole contract with the one surface the user has already approved. A `sm:`
   * or `md:` step on a page container means the tablet gets a third design
   * nobody screenshots, which is how the desktop one drifted to begin with.
   */
  test('the page measures step only at lg and above', async () => {
    const source = await readV3Source('components/PageLayout.tsx');
    const measures = source.slice(source.indexOf('const MEASURES'), source.indexOf('} as const'));
    const steps = measures.match(/\b([a-z0-9]+):max-w-/g) ?? [];
    expect(steps.filter((step) => !/^(lg|xl|2xl):/.test(step))).toEqual([]);
  });
});

describe('v3 shell containment', () => {
  /**
   * Tailwind's `sr-only` is `position: absolute`, and an absolutely positioned
   * element is clipped by its nearest *positioned* ancestor — not by an
   * unpositioned one that merely has `overflow`. With nothing positioned
   * between a screen-reader label and the document, every `sr-only` span in a
   * long list resolved against the initial containing block and grew the
   * *document* rather than the scroll region: measured on production at
   * 1200×874 with 69 holdings, `documentElement.scrollHeight` was 4250 against
   * a `body` of 874, so the sidebar scrolled away and bare `<body>` showed
   * under it.
   *
   * `overscroll-none` is the second half — it keeps a rubber-band at either
   * end of the region from chaining to the document, where `<body>` carries
   * v2's `--background` rather than this tree's surface.
   */
  test('the scroll region is a containing block and does not chain its overscroll', async () => {
    const shell = await readV3Source('layouts/V3Shell.tsx');
    const main = shell.slice(shell.indexOf('<main'), shell.indexOf('</main>'));
    const className = main.slice(main.indexOf('className='), main.indexOf('data-scrollable'));
    expect(className).toContain('relative');
    expect(className).toContain('overscroll-none');
  });
});
