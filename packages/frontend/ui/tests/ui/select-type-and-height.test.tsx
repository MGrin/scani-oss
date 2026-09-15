import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Select, SelectTrigger, SelectValue } from '../../src/ui/select';

/**
 * The Select primitive tracks the v3 type scale, and its list never outgrows
 * the space it opens into.
 *
 * SC-990: it sized its type with Tailwind's raw `text-sm`, so seven v3 call
 * sites each overrode it with `text-body` by hand, and the one that did not —
 * the kitchen-sink gallery — rendered 14px beside 16px controls.
 *
 * SC-993: with the coarse-pointer 44px row floor, a fixed `max-h-96` held about
 * eight rows, and a nine-option list on an iPhone 15 Pro opened at -7px, its
 * first row clipped above the viewport. The cap is now the lesser of 24rem and
 * the height Radix measured as available.
 */
const SOURCE = await Bun.file(join(import.meta.dir, '../../src/ui/select.tsx')).text();
/** The file with its comments removed, so prose naming a class cannot count
 *  as using it, and an apostrophe in a comment cannot pair quotes wrongly. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the Select primitive', () => {
  test('the trigger renders on the v3 type scale', () => {
    const html = renderToStaticMarkup(
      <Select>
        <SelectTrigger aria-label="Currency">
          <SelectValue />
        </SelectTrigger>
      </Select>
    );
    // THE CONTROL: the trigger rendered at all, so the class reading is real.
    expect(html).toContain('aria-label="Currency"');
    expect(html).toContain('text-body');
    expect(html).not.toMatch(/\btext-(xs|sm|base|lg)\b/);
  });

  test('no class string in the file names a raw Tailwind type size', () => {
    const classStrings = [...CODE.matchAll(/'([^']*\btext-[a-z-]+[^']*)'/g)].map((m) => m[1]);
    expect(classStrings.length).toBeGreaterThan(2);
    expect(classStrings.filter((c) => /\btext-(xs|sm|base|lg|xl)\b/.test(c as string))).toEqual([]);
    expect(SOURCE).toContain("'py-1.5 ps-8 pe-2 text-label font-semibold'");
  });

  test('the list is capped by the space available, not only by 24rem', () => {
    expect(SOURCE).toContain('max-h-[min(24rem,var(--radix-select-content-available-height))]');
    const classStrings = [...CODE.matchAll(/'([^']*\bmax-h-[^']*)'/g)].map((m) => m[1]);
    expect(classStrings.length).toBe(1);
    expect(classStrings.filter((c) => /\bmax-h-96\b/.test(c as string))).toEqual([]);
  });
});
