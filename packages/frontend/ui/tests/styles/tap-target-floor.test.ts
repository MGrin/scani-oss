import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

/**
 * Why the 44px touch floor survives a `size="sm"` button, stated as a test.
 *
 * `v3-tokens.css` re-applies `min-height: var(--tap-target)` behind
 * `@media (pointer: coarse)`, and `button.tsx`'s `sm` variant pins
 * `min-h-[36px]`. Both end up unlayered — Tailwind's `@layer` directive
 * flattens `@layer base` into the same output as the utilities — so the only
 * thing deciding which one a phone gets is **specificity**, and the utility is
 * declared later in the file. The floor wins solely because
 * `[data-ui='v3'] :is(button, …):not(…)` carries more than one class-level
 * component. Nothing else is holding it up.
 *
 * SC-63 concluded the opposite and dropped `size="sm"` from three surfaces to
 * work around a defeat that was not happening; SC-73 measured it in Chromium
 * at 390px with `hasTouch` — 44px computed and 44px rendered, 36px only under
 * `pointer: fine`, which is what `sm` is for. Both readings are plausible from
 * the source alone, which is the argument for asserting the mechanism here
 * rather than leaving the next reader to re-derive it.
 *
 * This fails if someone narrows the floor's selector to a single class, or
 * gives a `size` variant an `!important` min-height that would outrank it.
 * `apps/frontend/app/tests/v3/token-hygiene.test.ts` guards the call sites.
 */

const CSS = await Bun.file(join(import.meta.dir, '../../src/styles/v3-tokens.css')).text();
const ROOT_CSS = await Bun.file(
  join(import.meta.dir, '../../src/styles/v3-tokens-root.css')
).text();
const BUTTON = await Bun.file(join(import.meta.dir, '../../src/ui/button.tsx')).text();

/**
 * Class-level specificity: classes, attribute selectors and pseudo-classes.
 * `:is()` and `:not()` take their most specific argument (CSS Selectors 4
 * §17), and only that component matters here — the floor and the utility it
 * has to beat both carry zero ids.
 */
function classComponents(selector: string): number {
  // A Tailwind class name escapes its brackets (`.min-h-\[36px\]`); left in,
  // the escaped pair reads as an attribute selector and doubles the count.
  let rest = selector.replace(/\\./g, 'x');
  let total = 0;
  // Functional pseudo-classes first, so their arguments are not double-counted
  // by the flat scan below.
  const functional = /:(?:is|not|where|has)\(([^()]*)\)/g;
  for (const match of rest.matchAll(functional)) {
    const args = (match[1] as string).split(',');
    const inner = Math.max(...args.map((arg) => classComponents(arg.trim())));
    // `:where()` contributes nothing, by definition.
    total += match[0].startsWith(':where(') ? 0 : inner;
  }
  rest = rest.replace(functional, ' ');
  total += (rest.match(/\.[\w-]+/g) ?? []).length;
  total += (rest.match(/\[[^\]]+\]/g) ?? []).length;
  total += (rest.match(/:[\w-]+/g) ?? []).length;
  return total;
}

/** The rule that spends `--tap-target`, as written. */
function coarseFloorSelector(css: string = CSS): string {
  const flat = css.replace(/\s+/g, ' ');
  const query = flat.indexOf('@media (pointer: coarse)');
  expect(query).toBeGreaterThan(-1);
  const decl = flat.indexOf('min-height: var(--tap-target);', query);
  expect(decl).toBeGreaterThan(-1);
  const open = flat.lastIndexOf('{', decl);
  const start = Math.max(flat.lastIndexOf('{', open - 1), flat.lastIndexOf('}', open - 1));
  return flat.slice(start + 1, open).trim();
}

describe('v3 coarse-pointer tap floor', () => {
  test('the specificity function agrees with CSS Selectors 4 on the cases used here', () => {
    // A Tailwind utility — the thing the floor has to beat.
    expect(classComponents('.min-h-\\[36px\\]')).toBe(1);
    // `:is()` / `:not()` take their most specific argument, not their count.
    expect(classComponents("[data-ui='v3'] :is(button, [role='button'])")).toBe(2);
    expect(classComponents(':not(button, [role="checkbox"])')).toBe(1);
    expect(classComponents(':where([role="button"])')).toBe(0);
  });

  test('the floor out-specifies any single-class utility', () => {
    const selector = coarseFloorSelector();
    expect(selector).toInclude("[data-ui='v3']");
    // Strictly greater than 1, which is every `min-h-[…]` Tailwind emits.
    expect(classComponents(selector)).toBeGreaterThan(1);
  });

  test('no button size variant can outrank it with !important', () => {
    // Tailwind's `!` modifier emits `!important`, which beats the floor at any
    // specificity — the one way a `size` prop really could defeat the minimum.
    const sizes = BUTTON.slice(BUTTON.indexOf('size: {'), BUTTON.indexOf('defaultVariants'));
    expect(sizes).not.toInclude('!min-h');
    expect(sizes).not.toInclude('!h-');
  });

  test('every size variant under 44px is one v3 neutralises', () => {
    // The floor only reaches elements the neutraliser lists. A variant that
    // pinned a sub-44px height on, say, a `div` would be outside it — so the
    // sizes are asserted to be button-shaped, which they are by construction
    // and which this pins.
    const under44 = [...BUTTON.matchAll(/min-h-\[(\d+)px\]/g)]
      .map((match) => Number(match[1]))
      .filter((px) => px < 44);
    expect(under44).toEqual([36, 36]);
    expect(CSS.replace(/\s+/g, ' ')).toInclude(':is( button,');
  });
});

/**
 * The `:root` variant is generated from the scoped one, and
 * `v3-tokens-root.test.ts` pins that it is byte-for-byte derived — but the one
 * thing generation *changes* is the very thing the block above asserts: the
 * `[data-ui='v3']` prefix is stripped, dropping the floor's specificity by one
 * component. Everything asserted above is therefore untested for the variant
 * `apps/frontend/landing` and `apps/frontend/cloud` actually import.
 *
 * It still wins, and by construction rather than by luck: `:is()` and `:not()`
 * each contribute their most specific argument, so `a[href]` and
 * `[role='checkbox']` leave two attribute-level components. That is one more
 * than any `min-h-[…]` Tailwind can emit — which is what holds the 44px floor
 * up under the landing's phone nav, where every target is a bare `a[href]`
 * carrying no height utility of its own.
 */
describe(':root variant coarse-pointer tap floor', () => {
  test('the floor survives losing its attribute scope', () => {
    const selector = coarseFloorSelector(ROOT_CSS);
    expect(selector).not.toInclude('data-ui');
    expect(classComponents(selector)).toBeGreaterThan(1);
  });

  test('it reaches a plain link, which is every landing nav target', () => {
    expect(coarseFloorSelector(ROOT_CSS).replace(/\s+/g, ' ')).toInclude('a[href]');
  });
});
